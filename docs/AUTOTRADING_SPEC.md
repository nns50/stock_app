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

     > **Corrected 2026-09-23: two pools, not three.** Both live risk checks halt on live
     > stock plus live options combined, so the alert now has one `live` pool on that sum
     > next to `paper`. Separate stock and options pools could each miss a halt split
     > across the sleeves, and the options pool could report a halt no check applied. The
     > marker is also the halt's only dated record, which the daily results row reads. See
     > "2026-09-23 (third)" below.

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
    **`optionsOwnExposurePool` (2026-09-10, default false):** that pool folds the EQUITY book
    in at full stock notional, and both checks are bare (the pool is measured before the
    candidate is added), so two same-sector equity positions — ~50% of equity each at the
    2.5% stop cap — close the sector to options at any size (the 2026-09-09 INTC refusal:
    $64 of premium against $6,183.90 of AMD + LITE stock). When on, both options paths
    (`liveOptionsExecute.ts`, `optionsExecute.ts`) build the sector / correlated pool from
    the options book's own open positions only, in premium terms; the shared aggregate-risk
    budget is untouched, mirroring `optionsMaxConcurrentPositions`'s slot split. Risk-check
    journal rows carry `exposurePool: 'shared' | 'options_only'` so a refusal reads without
    knowing the switch's state that day.
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

**Interim measurement, 2026-09-06 — the VETO half of the question, which does not
need the 25-trade sample.** R1-R4 above are about degraded trades that got
*booked*; the adjacent question is whether widening pushes a setup into the veto.
Over 400 `level_veto` events (2026-09-01 to 09-04): **142 (36%)** measured reward
against a stop widened past support, so the coupling is mechanically real — but
only **5 of 400 (1.25%)** would have cleared the 1R bar at the un-widened ATR
stop, and three of those five miss by 0.01-0.04R. `levelPlan.ts`'s own claim that
"the veto never fires on widening alone" is therefore very nearly right: the
arithmetic bound (a kR signal can only fall to k/(1 + maxStopWidenPct/100)) holds,
and the exceptions are trades whose target was *also* cut. **No change on the
veto side.** The booked-trade question above stays open on its own sample, which
at 19 matched closed positions (10 widened, 9 not) is still short of the 25+10
this document requires.

**Fixed the same day: `rewardR` was unsigned.** It was
`Math.abs(newTarget - entry) / newRisk`, so a target the wall capped onto the
WRONG SIDE of the entry was journaled as a small POSITIVE reward — PSKY on
2026-09-02 (entry 10.96, resistance 10.97, capped target 10.95) recorded as
"only 0.04R to the wall". 34 of those 400 vetoes carried the inversion, and it
reads as a thin setup rather than an impossible one to anything later counting
`rewardR` out of the journal — including the measurement above, which had to
solve for the implied stop to notice. Behaviour is unchanged (`reachedWrongSide`
already vetoed these, and a negative number is under any positive
`minRewardR`); the recorded fact is now true, and the message says "the capped
target is on the wrong side of the entry" instead of quoting a reward that does
not exist.

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

**Exception, 2026-09-10 — a clock rule outranks a working close.** The skip
above hid a position from the HARD TIME exit too, so a close resting above where
the contract could be sold silently switched off the one rule whose cost is
certain (NKE: a $0.20 sell against a $0.12 mark, unfilled for 4h20m on a 1 DTE
contract). Once `clockForcesCloseToday()` is true — the short-dated hard exit,
the end-of-day flatten, or `maxHoldDays` — a working close whose limit sits ABOVE
the current mark is cancelled and re-placed; one at or below the mark is left to
work, because it can still fill and re-pricing it downward would give up real
money. The cancel is issued only at the moment an exit rule has chosen to place,
never speculatively, and a refused cancel places nothing.

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
audit before trusting the gate, and these were invisible until now. Since
2026-09-19 those rows are replayed nightly at several gaps after the exit and
judged by the leak scan — the section "2026-09-19 (sixth)" below.

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

1. cancel the legs, **TAKE-PROFIT first and STOP last** (`cancelOrderForLegs`)
2. **RE-READ the broker and confirm both are gone.** A cancel is an accepted
   REQUEST, not a completed action; selling against a leg that is still resting
   is the accidental short the whole scale-out design exists to prevent
3. **re-bracket the REMAINDER, before anything sells**
4. only then sell the partial

Steps 3 and 4 were the other way round until 2026-09-05, and the old shape is
worth recording because it was live-but-unreachable behind the flag for a day:
sell the partial, re-bracket, and force-close the remainder if that re-bracket
failed. Only steps 1 and 2 were ever implemented — the function journalled
"unprotected … re-arm by hand" and returned OK, and the caller then sold.
Turning the flag on would have cancelled the bracket, sold the partial, and left
the remainder with no stop and no target indefinitely.

Bracketing before selling removes the bad state rather than recovering from it.
If the re-bracket fails, nothing has been sold, so the rollback is to place a
bracket for the FULL position and abandon — back to a protected position and a
missed partial. Sell-first has no such rollback: the shares are gone and the only
move left is a forced close, chosen under time pressure. One asymmetry in that
rollback: a KNOWN rejection means no bracket exists, so a full-size restore is
safe, while an UNANSWERED placement may well be resting and stacking a second
bracket on it is two stops against one position — so an unanswered re-bracket is
journalled and left to the next tick's `checkLiveBracketProtection`.

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

## 2026-09-04 — deep-dive sweep: the same lookup bug, third occurrence

Prompted by a request to find everything at once rather than one bug per change.
Two real defects, both in the class this codebase keeps reproducing.

### 1. The manual close button was broken for every adopted position

`closeLivePosition` gated its bracket cancel on `pos.sourceIntentId !== null`:

```ts
if (pos.sourceIntentId !== null) {
  const entryIntent = getIntent(pos.sourceIntentId);
  if (entryIntent?.isBracket) await cancelLiveBracketExitLegs(entryIntent, accountId);
}
```

An ADOPTED position never has `source_intent_id` — adoption deliberately leaves
it null, because that null is the "orphan, needs linking" signal the adoption
path matches on — and from 2026-09-01 essentially the whole live book is adopted.
So the cancel was skipped for every live position, and
`cancelLiveBracketExitLegs`' own comment records the cost:

> "a close was rejected as 'will reverse an existing position' until the resting
> stop/target was cancelled by hand"

Best case the broker refuses the close and the button simply fails. Worse, if a
close is accepted, the resting legs outlive the position and the next fill sells
shares no longer held.

**Third occurrence of this exact lookup bug**, after the CTVA stagnation close
(21 consecutive failures) and `checkLiveBracketProtection` (ten days of a dead
alarm). `entryIntentIdForPosition` is now exported and shared rather than
re-derived per call site. The `riskProfile` lookup beside it had the same
weakness and silently used the config default instead of the profile the entry
was sized under.

Regression test asserts an adopted position's bracket IS cancelled; reverting to
`pos.sourceIntentId` fails it.

### 2. The options exit sweep closed other accounts' positions

`checkLiveOptionsExits` read `listOpenLiveOptionsPositions()` unscoped and then
placed each close against `freshCfg.liveAccountId` — so a row belonging to
another account on the same login would be closed against the TRADING account,
an order to sell contracts that account does not hold. Same class as the
snapshot fix earlier today; latent while one account is in use, and reachable now
that live options are on.

**Unassigned rows are deliberately KEPT here**, which looks like it contradicts
the "closing means don't act on ambiguity" rule stated for the snapshot. It does
not — excluding them DEADLOCKS against that gate. The snapshot counts an
unassigned row, holding "max 1 at a time" shut; an exit sweep that refused to
close one would leave it blocking every future options entry forever with nothing
able to clear it. A legacy row without `account_id` was written by this same
loop, so closing it in the configured account is the safe reading. A row
positively belonging to a DIFFERENT account is the dangerous case, and that is
what is now excluded.

### Checked and found CORRECT

- `accountState.ts` reads `asset.buying_power` off the per-currency asset with an
  `overnight_buying_power` fallback. The vendor docs list `buying_power` and
  `settled_cash` as per-currency fields, but this account's wire payload omits
  both — the captured shape is authoritative over the docs for what a given
  account actually returns, and the fallback chain already handles it.
- Every other `sourceIntentId` gate: the adoption paths (where null IS the
  signal) and the OR-conditions that still pass via tags.

### 3. The auto-tuner measured R against a stop the ratchet had moved

Two derivations of one quantity, disagreeing — the invariant CLAUDE.md names:

```
routes/journal.ts:178   stopPrice: p.initialStopPrice ?? p.stopPrice   <- frozen, correct
autoTune.ts:164         stopPrice: p.stopPrice                          <- MUTATED by the ratchet
```

The journal route was corrected for exactly this and carries a comment saying
why. `autoTune.ts` was never updated, so the two callers of `excursionForTrade`
computed different R for the same trade.

It matters most here of all the places it could have happened. A winner whose
stop was pulled to breakeven has `stopPrice === entryPrice`, so the denominator
is **zero**, `initialRisk` comes back null, and the trade is dropped from the
excursion set entirely. The ratchet fired **36 times on 2026-09-04**, and it only
fires on trades that go far enough to trigger it — so the rows silently discarded
were precisely the WINNERS the tuner exists to learn from. Every proposed
`stopAtrMultiple` / `targetRMultiple` would have been fitted to whatever
losers survived.

This has been latent because `autoTuneExitsEnabled` is off. It would have
mattered the moment it was switched on, which is the pending decision at 20
winners (task #32).

Regression test ratchets two winners to breakeven and asserts the tune lands on
the same multiples as the un-ratcheted case. Reverting to `p.stopPrice` makes
`exitsAdjusted` false — the tuner finds no usable winners at all.

## 2026-09-06 — the scale-out has never once executed, and the half-cancelled bracket

Two findings, one of which is the answer to "why does profit never get taken
quicker".

### The scale-out has never executed. Not once.

`live_scale_out_placed` has **never been journalled** — the events endpoint
reports it in `actionsNeverSeen`. Against that, `live_scale_out_blocked` has
fired **141 times** across three sessions (89 on 09-02, 9 on 09-03, 43 on 09-04),
every one of them the same broker refusal:

> The number of take-profit orders and the number of stop-loss orders must be the
> same.

Every attempt sends exactly one `STOP_PROFIT` and one `STOP_LOSS` — one of each,
which is what the message asks for — and is refused anyway. (An earlier read of
this journal suggested some attempts sent only ONE leg; that was wrong. The 98
rows without a `sent` field predate that diagnostic being added, and their
`reason` names two leg ids. All 141 attempts are two-leg.)

So the 0.30R partial profit-take is armed (`liveScaleOutEnabled: true` in
production), tries every tick, and has never taken a dollar. All three routes to
reducing a bracket are closed at once:

| route | state |
|---|---|
| in-place modify | refused by the broker, 141/141 |
| cancel-and-replace | implemented, `liveScaleOutCancelReplaceEnabled: false` |
| two brackets at entry (per-lot) | not built |

That is worth stating plainly because the mechanism *reads* as active
everywhere — config, UI, journal — while taking no profit at all. It is the same
disease CLAUDE.md's config-reachability rules exist for, one layer further out:
the field is read, the code runs, and the broker refuses.

### The half-cancelled bracket (fixed)

The blocker keeping cancel-and-replace off was a real one.
`cancelReplaceBracket` cancels the resting legs one at a time and returns on the
first failure, so a refused second cancel leaves the bracket **half** gone —
and which half survived was decided by whatever order the broker listed the legs
in:

| cancelled first | second cancel fails | result |
|---|---|---|
| STOP | target | position runs with a take-profit and **NO STOP** |
| target | STOP | position keeps its **STOP**, loses only its target |

The first row is real money with unbounded downside and nothing that sells to
reveal it. `checkLiveBracketProtection` does identify it (since 2026-09-05 it
asks "is THIS position's stop still there", not "is anything resting") — but it
only *reports*, once per ET day, and tells a human to re-arm by hand.

`cancelOrderForLegs` now orders the cancels: **take-profit first, stop last**.
Legs whose role cannot be read sort *between* the two, never last — "I cannot
tell what this is" must not displace "this is the protection" from the safest
slot — and the sort is stable, so equal ranks keep the broker's order.
`buildBracketResizePatches` has already refused anything that is not one
take-profit plus one stop (or a lone leg) before this point, so the ordering is
total for every input that can reach it.

This does not make the cancel succeed. **It makes its failure survivable**, which
is the difference between a nuisance and a naked position.

The journal follows: the mid-cancel row now says which legs actually went,
*derived* from what was cancelled rather than assumed, and a lost stop is
reported as `live_position_unprotected` — an action `liveFailureAlert` pages on,
verified in production as reaching a `live_ambiguity_alerted` dispatch within
1–60 minutes on all 6 occurrences to date — rather than `live_scale_out_blocked`,
which alerts on nothing. The `stopGone` branch is unreachable given the ordering
and is documented in the code as a defence against a future change, not as a
live case.

Mutation-verified five ways, including reverting the wiring in `liveExecute.ts`
while leaving `cancelOrderForLegs` correct — asserting at the consumer, per
CLAUDE.md, not just at the producer.

## 2026-09-06 — auto-tune's risk ratchet only turns one way

Every risk adjustment auto-tune has ever made, from the production journal:

| date | change | Kelly | n |
|---|---|---|---|
| 07-29 | 1.74 → 1.24 | 0.56 | 41 |
| 07-30 | 1.24 → 0.94 | 0.94 | 45 |
| 08-06 | 1.74 → 1.24 | 0 | 68 |
| 08-07 | 1.24 → 0.74 | 0 | 69 |
| 08-08 | 0.74 → 0.24 | 0 | 70 |
| 08-09 | 0.24 → **0** | 0 | 70 |
| 08-26 | 2.14 → 1.97 | 1.97 | 30 |

**Seven adjustments, seven decreases.** Against that, `auto_tune_risk_increase_blocked`
has fired **22 times** — every single increase the tuner has ever wanted, refused. The
tuner has never once raised risk.

### Why the increase path is effectively closed

A decrease applies on a raw Kelly point estimate with no significance test at all. An
increase must clear `checkOosEdgeConfirmation`: a bootstrap 95% CI on the most recent
half of closed trades, whose low end must sit above zero.

Measured 2026-09-06 on the 87 dated closed autotrade trades (OOS window = the last 43):

```
expectancy  +$1.51/trade      stdev  $38.34      SE  $5.85
bootstrap 95% CI   -$8.85 … +$13.75      ->  not confirmed
to confirm at n=43 the expectancy would have to exceed  ~$11.46/trade  (7.6x the actual)
required OOS n at the CURRENT edge:  ~2,473  ->  ~4,945 closed trades in total
```

At roughly 9 trades a session that is over 500 sessions. The gate is not "hard to pass",
it is closed for this strategy at this edge.

One real contributor is that the guard judges in DOLLARS while `riskPerTradePct` itself
moved 2.14 → 1.97 → 1.25 (and 2.14 → 0 → 2.14 before that) across the same window, so a
dollar result mixes bets of very different size. Re-running the identical bootstrap on
R-multiples instead:

```
expectancy  +0.051R      stdev  0.617      CI  -0.119 … +0.234   ->  still not confirmed
required OOS n:  ~566  (a 4.4x improvement on the dollar figure, still far away)
```

So R-normalising the guard would be a genuine improvement — and would still refuse today.
**The guard is right.** An expectancy of +0.051R ± 0.18R is not a demonstrated edge, and
declining to size up on it is the correct call.

### What IS wrong is the asymmetry

The two directions are judged by wildly different standards: a decrease needs a point
estimate, an increase needs statistical significance. So noise walks risk down and can
never walk it back. That is exactly the 08-06 → 08-09 march: Kelly read 0 on a noisy
window and risk fell to zero in four nights with no test applied to any step.

And zero is not a smaller bet, it is a halt — 0 risk sizes every position to 0 shares.
Recovery is worse than an ordinary halt because the guard's population is CLOSED trades:
at 0 nothing opens, nothing closes, and the evidence set is frozen. Every recovery in the
record (0 → 2.14 between 08-09 and 08-26) was a human.

### Shipped now, and what was deliberately not

Shipped: a step that lands on 0 journals its own `auto_tune_book_halted` action and
pushes a notification that says the book will open nothing, that auto-tune cannot raise
it back on its own, and that risk must be set by hand to resume. Observability only —
**it does not change the number.**

Not shipped, because it is a decision about how much real money is at risk rather than a
diff (same rule as `liveMinSignalScore`'s default): a floor under the auto-tune cut, and
R-normalising the OOS guard. Both are recorded in task #47.

No Tuesday exposure either way: Kelly currently reads 3.0 (the cap), so tonight's run is
an *increase* attempt, which the guard will block. Risk stays at 1.25%.

## 2026-09-06 — a paper position on an unquotable symbol was immortal

`checkPaperExits` opened with an unconditional early return on a quote failure:

```ts
try { last = (await getProvider().getQuote(pos.symbol)).last }
catch (err) { return { symbol, closed: false, reason: `Quote fetch failed: ...` } }
```

Every paper exit — stop, target, hold-days, end-of-day flatten — sits BELOW that
line. So a symbol the provider can no longer quote produced a position nothing
could ever close, and unlike the live book there is no broker-side bracket to
fall back on: this loop **is** the broker.

It happened. GREE was opened 2026-07-21 10:11 ET and was still open on 09-06 —
**47 days** — because `/api/quotes/GREE` answers `{"error":"No Webull quote for
GREE"}` and always will. At `maxConcurrentPositions: 3` that is a third of the
paper book's capacity dead since July.

That cost is not confined to paper P&L. Paper is the control group every "should
we turn this on live?" decision is measured against — the shorts verdict in task
#21 is decided on exactly this population — so a permanently held slot quietly
shrinks the evidence behind those calls.

### The rule that was missing

A clock exit is not a price question. The live path already gets this right and
says so in its own comment: `checkLiveEquityTimeExits` sets the flatten trigger
**before** fetching any quote, and a failed quote there produces a journaled
`timeExitFailure` that retries next tick, with the resting broker bracket
protecting the position meanwhile.

Paper now matches. `last` is `number | null`; `stopHit` and `targetHit` require a
price (they are genuinely questions about price) while hold-days and the flatten
do not. `applyPositionManagement` is skipped rather than guessed — a trailing
stop cannot be ratcheted against a price we do not have.

### Booking a close with no price

Every candidate exit price is a fabrication, so the choice is which bias to take:

| candidate | why not |
|---|---|
| `bestPriceSinceEntry` | a high-water mark — flatters every such trade |
| `stopPrice` / `targetPrice` | asserts a fill that never happened |
| `entryPrice` | **neutral** — books a scratch, biases nothing |

So it books flat, and the journal carries `unquotable: true` and
`pnlIsNotAMeasurement: true`. Anything reading paper performance should exclude
these rows rather than average a fabricated zero into the record.

### And it is no longer silent

A quote failure used to put a `reason` on the returned outcome and nothing else —
no journal row, no alert. A new `paper_position_unquotable` action fires once per
position per ET day (the same throttle `live_position_unprotected` uses, and for
the same reason: the condition persists until someone acts, so every tick would
bury it and once-ever would let it go quiet while the slot is still held).

Mutation-verified four ways: restoring the early return, booking at the stop
instead of entry, dropping the once-per-day throttle, and letting a missing price
read as a stop hit.

## 2026-09-06 — the intermittent suite failure was a recycled pid

Task #46 recorded two failure signatures from six full-suite runs, unattributed.
Signature A is now reproduced, root-caused and fixed.

### The mechanism

`vitest.config.ts` pointed the tests at
`os.tmpdir()/stock-app-vitest-${process.pid}.db`, and **nothing ever deleted
it**. Two facts turn that into a flake:

- 603 of those files were sitting in `/tmp` on 2026-09-06.
- `/proc/sys/kernel/pid_max` is 32768, and Linux hands pids out sequentially and
  wraps — so a later run eventually opens a file an earlier run left behind.

`initDb()` is all `CREATE TABLE IF NOT EXISTS`, so it **adopts** that state
rather than replacing it.

### Reproduced exactly

Pointing the suite at one of the stale files reproduces Signature A's four
failures, by name and by message:

```
autotradeRealEstateClassifier  "caches a successful classification"
historicalData                 "fetches from Polygon and caches"
historicalData                 "serves from cache without a second fetch"
historicalData                 "re-fetches when the requested range extends"
```

All four are cache tests, and all four fail as "the mock was never called" —
because a previous run had already populated the cache the test expects to be
empty. The stale file carried `autotrade_sector_cache` 72 rows, `universe` 509,
plus `backtest_bars`, `backtest_fetch_log` and `quote_cache`.

Two nastier variants exist and were both observed while investigating:

- a stale file whose WAL sidecar is missing is **malformed**, and better-sqlite3
  throws `database disk image is malformed` on the first pragma — killing a
  whole test file before one test runs;
- a stale file carries an **old schema** (one had an `autotrade_config` with 3
  columns), which `migrate()` only partially repairs since it names specific
  tables.

CI never saw any of this: a fresh container per run means there is never a file
to collide with. That is precisely why the suite could be red locally and green
on every PR.

### The fix

Make reuse impossible rather than detectable. `test/dbFile.ts` builds a path
that is unique per run (pid **plus** random suffix), and `test/globalSetup.ts`
deletes it — with its `-wal`/`-shm` sidecars — on teardown, and sweeps
same-prefix leftovers older than a day for runs that crashed before teardown.
The sweep is bounded three ways (temp dir, exact prefix, one day old) so it can
never delete a concurrent run's database.

Mutation-verified four ways: collapsing the name back to pid-only, dropping the
sidecar removal, dropping the age bound, and dropping the prefix bound.

### Signature B: mechanism found, and reproducible on demand

`runLiveExecution` gates on `evaluateEntryCutoff(cfg, Date.now())` — the **real
clock** — and returns before `evaluateRiskCheck` when it blocks, which is exactly
`seenContexts.length === 0` in all four wiring tests.

`setAutotradeConfig` is a PARTIAL patch over a config row every test file shares,
and `finishLineWiring.test.ts`'s `cfgFields` never set `endOfDayFlattenMinutes`.
`autotradeLiveExecute.test.ts` sets it to 5 and sorts earlier, so it always runs
first — leaving the cutoff at `5 + max(runway, stagnationExitMinutes)` ≈ 95
minutes. The file therefore failed whenever the suite happened to run inside a
real ET session within ~95 minutes of the close, and passed at every other hour.

That accounts for every property of the signature: intermittent under a
deterministic file order, clustered rather than spread, and impossible to
reproduce outside market hours because `minutesUntilClose()` returns null there.

Reproduced exactly — all four failures, same assertion, same line — by giving the
file the inherited value and a system clock inside the window.

Fixed by pinning `endOfDayFlattenMinutes: 0` and `stagnationExitMinutes: 0` in
`cfgFields`, and asserting it as a property (`evaluateEntryCutoff` cannot block
with this config, at a moment one minute before a real close) rather than by
moving the system clock — fake timers in a file whose other tests share its state
are their own hazard. Mutation-verified: restoring the inherited values fails the
new test.

### What is STILL not fixed

**A residual flake with the same outward shape survives both fixes.** Across four batches of full-suite runs
after both fixes: 1 failure in 16, then 2 in 6, then 0 in 6, then 0 in 6 — always
the same four `finishLineWiring` tests, always `seenContexts.length === 0`, and
always with **zero leftover database files**. So it is a third cause, not the
two above.

It also evades instrumentation: six runs with a `console.error` dumping the
refusal reason were all clean. The rate is noisy enough (roughly 10-20%) that the
probe's presence is more likely coincidence than an observer effect, but it means
the gate that fires is still unknown.

What the next occurrence will now say for itself: `factorAfterRun` puts the
`runLiveExecution` outcomes — which carry the refusal reason — into the assertion
message. A bare "expected 0 to be greater than 0" names none of the dozen gates
that can return early, and that is the single reason this took days to attribute.

One deduction worth keeping: `sequence.shuffle` is not configured, so with
`fileParallelism: false` the file order is deterministic. A failure that is
intermittent under a fixed order is therefore **not order-dependent**, which
rules out the hypothesis #46 recorded as its next step and points instead at
wall-clock/timing dependence or async raciness inside a single file.

NEXT TIME: keep the full log (`npx vitest run --root server > run.log 2>&1` in a
loop, breaking on failure) and note the wall-clock time — a test that behaves
differently across an ET session boundary would look exactly like this.

## 2026-09-06 — the walk-forward guard now judges in R, not dollars

Task #47's second half. The guard that gates every auto-tune risk INCREASE read
per-trade **dollars**, while `riskPerTradePct` itself moved `2.14 → 1.97 → 1.25`
across the very window it reads (and `2.14 → 0 → 2.14` before that). So the
series mixed bets of very different size, and the spread it measured was partly
the **sizing history** rather than the edge.

Measured on the 43-trade out-of-sample window as it stood:

```
dollars   expectancy +$1.51    stdev $38.34   CI  -$8.85 … +$13.75
          -> ~2,473 out-of-sample trades needed to confirm at this edge
R         expectancy +0.051R   stdev 0.617    CI  -0.119 … +0.234
          -> ~566
```

A **4.4x** improvement, and it still refuses today — which is the point. This
corrects *what* is measured; it does not lower the bar. `+0.051R ± 0.18R` is not
a demonstrated edge and the guard is right to say so. What it fixes is that in
dollars the bar was unreachable in any realistic number of trades, which is what
made the risk ratchet permanently one-way: seven risk adjustments in the whole
record, all decreases, and all 22 increases blocked.

### Two details that matter

**A trade with no usable initial stop has no R, and is DROPPED rather than
counted as zero.** Counting it as a scratch would drag the mean toward zero with
a number that was never measured. Dropping shrinks the window, which can only
make the guard *refuse* — the safe direction for a gate on a risk increase.
(Coverage is not a problem in practice: every trade in the live book's
out-of-sample window had a usable initial stop.)

**The journal fields were renamed with the unit.** `oosExpectancy` → 
`oosExpectancyR`, `oosCiLow` → `oosCiLowR`. Rows written before and after
otherwise carry different quantities under the same name, and a `$5.54` sitting
next to a `0.051` in one field is exactly the silent unit mismatch CLAUDE.md's
"two places deriving the same quantity" rule exists to prevent.

Mutation-verified two ways: reverting to dollars, and counting a stopless trade
as 0R instead of dropping it. One test fixture had to gain a stop — real
autotrade positions always carry one, so a fixture without it was the
unrealistic case.

### Still not done

The **floor** under an auto-tune cut (#47's first half) is unchanged and remains
an operator decision about real money, not a diff. Nothing here stops
`riskPerTradePct` reaching 0; it only makes the road back reachable in principle.

## 2026-09-06 — DECISION: no floor under an auto-tune risk cut

**Operator decision. Do not add a floor, and do not let a later review talk
itself into one.** The same standing-decision framing as the `targetRMultiple`
hold — recorded here rather than only in a task list so it outlives the session
that made it.

### The question

Should auto-tune be forbidden from cutting `riskPerTradePct` below some minimum
(e.g. 0.25%)? At 0 the book opens nothing, and because the walk-forward guard's
population is *closed trades*, nothing closes either — the evidence it waits for
can never arrive. That is a trap state, and it happened: risk hit 0 on 08-09 and
a human moved it on 08-26.

### Why the answer is no

**The harm was never the 0. It was that nothing said so.** Seventeen days of a
silently switched-off strategy, announced as an ordinary "risk-per-trade
adjusted" reading `0.24% → 0%`.

PR #520 collapses those seventeen days into a push notification within a minute
of the tune run, saying in plain words that the book will open nothing and needs
a manual reset. The alert path is verified — `notification_delivery_failed` has
never been journalled, across every alert this system has ever sent.

So a floor now buys only the gap between *"you are told within a minute"* and
*"it never fully stops"*, and pays for it by risking real money at the exact
moment Kelly's own estimate says the edge is zero or negative. That is a poor
trade for a condition that has occurred **once in two months**.

The deciding argument is the subtler one: **a floor makes the system look
healthier without making it healthier.** A book grinding along at 0.25% because
a floor will not let it stop is still a book with no measured edge. Better that
the halt be loud and real, and that a human decides whether the strategy should
resume.

### What would reopen it

Any one of:

- a halt fires and the notification does **not** reach the operator;
- a halt fires, the notification arrives, and it is not acted on within a day;
- halts start recurring — say more than once a quarter.

At that point the notification has been shown not to be sufficient, and the
floor earns its place.

### Also considered and rejected

Applying the same significance test to *decreases*, to make the two directions
symmetric. That would pin risk wherever it happens to sit whenever the edge is
unclear — which is most of the time. The safe direction should stay easy to
take; the asymmetry is only a defect because the *increase* side was
unreachable, and PR #523 is what addressed that.

## 2026-09-08 — an HMM market-regime reading, as an observer

**What shipped.** A three-state Gaussian hidden Markov model over daily S&P 500 log returns,
ln(VIX) and ln of the 20-day realized volatility, trained offline in Python on five years of
FRED closes and shipped as `server/data/regimeModel.json`; a TypeScript forward filter held to
the Python reference by a fixture of real rows (`server/test/regimeModelParity.test.ts`); and
the **reading** — `services/mlRegime.ts`, `GET /api/market/regime-ml`, the ML block of the
Today page's Market regime tile, the loop's once-per-tick read mirrored on the tick summary
and the Auto-Trade page's _Last cycle_ card, and the journal actions `ml_regime_read`,
`ml_regime_changed`, `ml_regime_drift`, `ml_regime_fetch_failed`, `ml_regime_override`. The
model card is `docs/MARKET_REGIME_MODEL.md`; the walk-forward evidence is in `ml/reports/`.

**Why an observer first.** The reading has to be watched before anything is allowed to act on
it: the model is read one to two sessions behind (FRED's publication lag), a two-session
spike is invisible to a 20-day feature (Aug-2024 in the walk-forward), and the drift flag is a
retrain signal rather than a gate (a drift-as-unknown rule would have switched an overlay
off on 92% of the COVID-crash sessions). Twenty sessions of journaled readings are the
minimum before the enabling rules below can even be evaluated.

**Two findings recorded here because they changed the design.** (1) The third feature is the
_log_ of the 20-day standard deviation: on the raw scale the COVID crash defined the high-vol
state and the 2022 bear market read as Sideways (33% High Vol out of sample); on the log
scale it reads 67%. (2) States are labeled by their fitted VIX ordering, with the drift
ordering of the high- and low-vol states asserted and the two calm states' drifts only
reported; the earlier rule refused a valid 2020-04 refit.

### What this does NOT do

- It does not size, gate, tighten or stamp anything. Every consumer of the reading is a
  later, separately gated change that ships OFF, with its own evidence and its own rows here.
- It is not a direction forecast. "Bearish" and "Bullish" are the states' fitted drifts over
  the training window; out of sample, the sessions read as High Volatility/Bearish had the
  _highest_ next-20-day returns (the post-stress bounce). What it separates is volatility:
  next-20-day realized vol 1.51% [1.43, 1.60] in High Vol against 0.75% [0.73, 0.76] in Low Vol.
- It cannot see today or intraday. Day one of a shock is never in the data; the intraday
  range nowcast planned beside the overlay covers that case.
- A stale or missing reading is `unknown`, and `unknown` is what every future consumer must
  treat as "no overlay" — nothing is ever cut, tightened or gated on a guess.

### Pre-committed enabling rules for anything that acts on the reading

1. A walk-forward grid on the out-of-sample regime path picks the cut/tighten cell by a rule
   written before the run (the backtest step), never a hand-chosen number.
2. At least 20 sessions of `ml_regime_read` with no more than 2 `ml_regime_changed` per week.
3. `npm run regime:predict` and `GET /api/market/regime-ml` agree on every one of those
   sessions (same `asOf`, same probabilities to 1e-6).
4. Revert to OFF after 5 stale sessions in a row; retrain quarterly (`training.retrainBy`)
   and re-run rule 1.

## 2026-09-08 — the ML regime label is stamped at entry

Every position the loop opens now carries the HMM reading's regime as at-entry context, the
way the 2026-07-26 trio (raw score, market-regime label, market ATR%) already does: a
nullable `ml_regime` column on `positions`, `autotrade_paper_positions`,
`autotrade_options_paper_positions`, `autotrade_live_options_positions` and the two live
**order** tables — the order row is where a live position's context lives until the fill
materializes it, so the column has to exist there or the position would never get it. The
loop hands each executor the label once per tick; the journal export gains `mlRegime`.

**NULL means unknown, stale, or not read — never a guess.** The label is stamped only from a
reading that is known and fresh; a stale morning, a missing model, or a source switched off
stamps nothing. Capture-only: nothing about entries, sizing or exits changes. It exists so
realized results can be sliced by the regime they were entered under before anything is
allowed to act on that regime, and so the later options-exit tighten can read the regime a
position was *opened* under rather than today's.

## 2026-09-08 — the ML regime size cut, built and left OFF

**What shipped.** The regime sizing factor (`server/src/services/autotrading/effectiveRisk.ts`)
now has three triggers and one cut. `regimeTriggers()` reads SPY's 14-day ATR above
`regimeAtrThresholdPct` (the 2026-07-16 trigger, which has never fired on this book), the HMM
reading High Volatility/Bearish with `mlRegimeEnabled`, and an intraday **shock day** — SPY's
range so far today at or above `regimeShockRangeRatio` × that ATR, from the quote's high/low
(`executionGuards.getMarketRangePct`: null without a real high, low and previous close, and
refused on the synthetic provider). It returns the deeper configured cut (never the product:
ATR 40 + ML 35 is 40), a `skip` for a cut of 100 or more (a FAILING `regime_sizing` rule through
the normal refusal path, so the journal names it), and the one `effectiveRegime` every consumer
reads. The loop derives it once per tick and hands each executor a `TickRegime` — the two
inputs and the effective regime; each executor feeds the inputs to its risk check, which calls
the same function per candidate for the sizing line, and stamps the effective regime on what it
opens, so a shock day is cut AND stamped High Vol, or neither. Both risk-check previews peek at
today's persisted reading (never a fetch). Four config fields, all `NEVER_TUNED`, with the
About page, the User Guide and `docs/AUTOTRADE_RISK_SETTINGS.md` ("Regime size cut — three
triggers, one cut") describing them: `mlRegimeEnabled` (false), `mlRegimeSizeCutPct` (35),
`mlRegimeSwitchThreshold` (0.6 — read by the reading itself on every classification, overlay on
or off), `regimeShockRangeRatio` (0). A shock day journals `market_shock_detected` once.

**Why 35, not the request's 50.** Cuts must be monotone in severity. The ATR trigger fires on
SPY ATR above 3% — a few weeks a decade — and carries the operator's 40%; the HMM's High-Vol
state is a broad condition, roughly one session in four over the training window, and a broad
trigger must not cut deeper than the extreme one. The per-trade ATR stop already vol-normalizes
share count, so this is a second layer on dollar risk for what a stop cannot see (gaps through
stops, correlations going to one, a long-biased edge weakening in bear tape); after the stop's
share, 30–40% is the residual. 50 stays available in the UI and in the grid, and the number
that ships ON is the walk-forward grid's cell, by its written rule — never this default.

**Why a nowcast.** A model read through FRED labels the morning after a shock; day one is
always missed, and the Aug-2024 spike was too short for a 20-day feature to see at all. SPY's
range so far today against the same ATR the ATR trigger uses is a nowcast of the same state,
so it takes the same cut and stamps the same regime by construction. It cannot be backtested
without foresight (a daily bar knows the full range only at the close), so it ships at 0 and
is judged on its first three live shock days against the model's next-session label.

### What this does NOT do

- It does not tighten targets, scale the daily goal, or raise the conviction bar. Those are the
  next changes behind the same switch, each with its own row here.
- It does not run in a backtest: the three engines write the overlay inert (`mlRegime: null`,
  overlay off, nowcast off) until the parity change carries the out-of-sample regime path in.
- It does not fire on a stale or unknown reading, on the synthetic provider's quote, or on a
  quote without a real high, low and previous close — null is "no trigger", never a guess.
- It never compounds with the ATR cut, and it never changes an open position.

### Enabling rules

The observer section's pre-committed rules apply unchanged: the walk-forward grid picks the
cell by its written rule; at least 20 sessions of `ml_regime_read` with no more than 2
`ml_regime_changed` per week; `regime:predict` and `GET /api/market/regime-ml` agreeing on every
one of them. Then set `mlRegimeSizeCutPct` to the grid's cell — not to 35, not to 50 — and
switch `mlRegimeEnabled` on; revert to OFF after 5 stale sessions; retrain quarterly and re-run
the grid. The nowcast has its own gate: `regimeShockRangeRatio` stays 0 until three
`market_shock_detected` days have been compared with the model's next-session label.

## 2026-09-08 — the ML regime target tighten, built and left OFF

**What shipped.** `services/autotrading/regimeTargets.ts`: `regimeAdjustedTargets(cfg, regime)`
multiplies `targetRMultiple` and `optionsTakeProfitPct` by `1 − mlRegimeTargetTightenPct/100`
(never below 0.1) while the overlay is on and `regime` is High Volatility/Bearish, and returns
the factor. Three consumers, one helper: (1) the loop's decide call and the `/decide` preview
(from today's persisted reading) hand `decide.ts` the effective `targetRMultiple`, so every
signal's `rMultiple` is the tightened one; (2) both live books' finish-line trim reasons about
the tightened payoff (`rewardMultiple`), guarded by the wiring scan; (3) the options exit rules
— the short-dated ladder and the %-of-premium take-profit, paper and live — read the regime
STAMPED on the position (`ml_regime`, which since the size cut is the tick's effective regime,
nowcast included), so a High-Vol entry keeps its tighter target through a calm afternoon and a
calm-tape entry is never tightened by a later switch. Equity targets are fixed at entry by the
bracket, so both instruments tighten at entry. The applied factor is stamped as
`regime_target_factor` on the same six tables as `ml_regime` (1 = untightened; NULL predates
the column), copied from the order row at live materialization, exported as
`regimeTargetFactor`. One config field, `mlRegimeTargetTightenPct` (30, `NEVER_TUNED`).

**Why at entry, and why the goal is not scaled.** A target moved after entry would either
loosen a bracket the broker already holds or tighten a position that was sized for the wider
one; at entry the trade's geometry, its size and its journal line agree. The daily goal is
scaled by the size cut (its own row), not by the tighten: the tighten changes the R
distribution — smaller wins, more of them — which the walk-forward grid measures rather than
assumes, and the counterfactual ledger (next) records per trade whether the full target would
have been reached.

**Interaction with the exit tune.** Auto-tune's exit tune moves the BASE `targetRMultiple`; the
tighten multiplies whatever it set (a tuned 1.75R reads 1.225R on a High-Vol morning). The tune
journal reports the untightened base.

### What this does NOT do

- It does not change an open position's target, and it never widens one.
- It does not scale the daily goal, raise the conviction bar, or run in a backtest — each is
  its own change with its own row.
- It does not tighten on a stale or unknown reading, or with the overlay off: factor 1, and
  the stamp says so.
- It does not read today's regime at an options exit — only the one the position was opened
  under.

### Enabling rules

The size cut's rules apply unchanged; the tighten shares `mlRegimeEnabled`. The number that
ships on is the walk-forward grid's tighten cell (0 / 15 / 30), by the written rule, and the
counterfactual ledger's pre-committed reading after 30 tightened trades decides whether it
stays: an optimistic full-target counterfactual that beats realized R with a CI excluding zero
sets the tighten to 0 for that regime and re-runs the grid.

**2026-09-10 follow-up (merge review).** A fourth reader of the tighten was missed: the per-lot
bracket split (`liveExecute.ts`, #550) rebuilds each lot's target from entry/stop/R rather than
reading the signal's already-tightened target, and it read `autotradeCfg.targetRMultiple` raw. With
both `livePerLotBracketsEnabled` and the overlay on in a High-Vol tape the runner lot would have
carried the full 2R while `regime_target_factor` on the row said 0.7 — two derivations of one
target, and a stamp the MFE ledger would have trusted. It now takes
`regimeAdjustedTargets(cfg, stamp).targetRMultiple`, the same helper as the other three consumers;
the partial lot's near target (`partialExitRMultiple`) is untouched, as before. Both flags were OFF
in production, so nothing traded under the gap. Regression test asserts the plan's runner price
(107, not 110, on a $5 R at 30%).

## 2026-09-08 — the daily goal follows the regime cut: held constant in R

**What shipped.** The baseline row (`autotrade_daily_baseline`) carries a nullable
`goal_scale` and `goal_scale_reason`. Once per in-session tick the loop hands
`updateDailyGoalScale()` the SAME `regimeTriggers` result the executors size by — one factor,
one derivation — and the row takes its factor while the day has no gain to protect;
`setDailyGoalScale` writes only `WHERE give_back_armed_at IS NULL AND reached_at IS NULL`, so
the line freezes the moment the guard arms or the day banks (derived from the two sticky
timestamps the row already has, no third flag). `evaluateDailyTarget` applies the scale before
anything else: `targetPct`, the arm and the floor are the EFFECTIVE numbers, with
`configuredTargetPct` and `goalScale` beside them, so every consumer — the entry gates, the
finish line, the score gate, the dashboard and the goal card — reads the scaled goal without
knowing it was scaled. The one consumer that did not read the status, `stopAdjust.ts`'s
day-protective stop, read `cfg.giveBackFloorPct` raw; it reads the status's floor now, so the
guard and the protective stop use one floor by construction rather than by coincidence. A
skip (cut 100) does not scale the goal: nothing opens, and a day with no entries must not bank
at +0%. `daily_goal_scaled` journals each change; `daily_target_reached`,
`daily_give_back_halted` and the pending-confirmation event carry the scale.

**Why in R.** `expected day % = entries/session × risk % × avg R`, and the tune solved the risk %
from it for a calm day. Cut every entry by _f_ and a fixed % goal becomes _1/f_ harder in R,
reachable only through more entries — in the one regime where more entries is the wrong
answer — while the bank line and the arm come later or never. Scaling the triple by the same
_f_ keeps the identity on both kinds of day (`entries × (risk × f) × avg R = f × goal`) and
every mechanism's meaning at the scaled line. The tighten does not scale the goal (it changes
the R distribution, which the grid measures); the tune, the goal evidence, the preview and the
sweep are scale-invariant; `targetDailyGainPct` never moves.

**The ordering it needed.** The regime inputs (SPY ATR, the range nowcast, the triggers and
the shock journal) now run right after the session and macro checks, before the screen, so the
goal is scaled before this tick's entry gates read it; they used to run after the screen. Same
tick, seconds earlier, no extra provider call: the ATR read is the one the volatility filter
already made, and out of session the tick still returns before it.

### What this does NOT do

- It does not move the stored goal, arm or floor, and it does not scale anything when the
  overlay is off (the factor is 1 and the row stays NULL — byte-identical to before).
- It does not follow a reading after the guard has armed or the day has banked.
- It does not scale for the tighten, or for a skip.
- Paper has no goal; nothing here touches the paper book.

## 2026-09-08 — the High-Vol conviction bar, built and left OFF

**What shipped.** `mlRegimeHighVolMinSignalScore` (0 = off, `NEVER_TUNED`) is a third source in
the one live score gate (`entryScoreGate.ts`): while the overlay is on and the tick's EFFECTIVE
regime — the same `regimeTriggers` derivation that cut the size and tightened the target — is
High Volatility/Bearish, a new live equity entry must clear it. Composed exactly as the
armed-day ramp already is: the strictest bar binds, `source` names it, and a skip journals
`regime_score_floor_skipped` through the once-per-day throttle. Ties go to the rule whose
journal action already has a history (armed day, then the everyday floor), so the tuning
plan's counts keep their meaning. `liveExecute.ts` hands the gate `regime.effectiveRegime`;
the source scan pins it. Live only, like `liveMinSignalScore` and for the same reason: paper
keeps screening at `minSignalScore` and stays the control group. The live options book has its
own conviction path (`optionsDecide.ts`) and is left alone.

**Why the bar rises where the size falls.** Across the 57 closed live trades that carry a score
every dollar came from scores 76–94 (+0.501R; the two thirds below lost $247 between them),
and the fitted live floor is the lever with the most evidence behind it. The same score
carries less edge in a High-Vol tape — a long-biased breakout edge weakens exactly there — and
a slot spent on a 74 in that regime is a slot the next 82 cannot have. Trading fewer names is
the complement of trading smaller; the walk-forward grid's second stage (off / 72 / 76 on
regime days, at the chosen cut/tighten cell) is what decides whether the bar earns its place.

### What this does NOT do

- It does not gate paper, options, or any entry outside a High-Vol effective regime.
- It does not replace the everyday floor or the armed-day ramp: it composes with them.
- It does not fire with the overlay off, on an unknown reading, or at 0.

### Enabling rules

The overlay's rules apply; the bar's number is the grid's stage-2 cell, set only after stage 1
has picked the cut/tighten cell, and reviewed with the cut on every retrain.

## 2026-09-08 — the counterfactual MFE ledger: measuring the tighten without a control group

**What shipped.** `services/autotrading/regimeTightenLedger.ts` (pure) and
`GET /api/journal/regime-tighten` (Journal › Analytics › Regime tighten). Every closed stock
trade stamped `regime_target_factor` in (0, 1), paper and live, is joined to its excursion
(`services/excursion.ts` — the same per-trade candle fetch and 50-trade cap as `/excursions`)
and read per trade: `tightenedTargetR` is the target as traded in R of the frozen stop,
`fullTargetR = tightenedTargetR ÷ factor` is the untightened bracket, `tightenedReached = mfeR ≥
tightenedTargetR`, `fullReached = mfeR ≥ fullTargetR`, a `bankedWin` is a tightened hit whose MFE
never reached the full target, and `counterfactualR = fullReached ? fullTargetR : realizedR`. The
ledger aggregates the counts, mean realized R against mean counterfactual R, and the bootstrap
95% CI of their per-trade difference (`significance.ts`), says what it could not cover (undated,
over the cap, unmeasurable, and tightened OPTIONS trades — their excursion is on the underlying,
not the premium — as `optionsExcluded`), and carries each row's bar resolution. Paper's realized R
is `paperRealizedR` (P&L over the original risk, the app's own paper R), so a scaled-out trade's
remaining quantity never inflates it; MFE is per share, so it is exact either way. The dashboard
counts the same population through the same predicate (`isTightenedFactor` and
`tightenedStockPositions` for the journal's rows, `TIGHTENED_FACTOR_SQL` for the paper COUNT and
list, pinned to the TS predicate by a boundary test) and the goal card points at the ledger once
ten tightened trades have closed — a count, never the candle fetch.

**Why a bound, and which way it leans.** With both books under the overlay nothing trades the
untightened target beside it, so the tighten's cost cannot be read as a difference between two
books the way the live conviction floor's can. The favorable excursion answers "would the full
target have been reached?" per trade, but what happened after is unknowable, so the
counterfactual takes the most optimistic case for the full target on both branches: reached →
banked at the full target with no reversal; not reached → the untightened trade did exactly as
well as the tightened one, although a banked win would in truth have stayed in and exited at no
better than its MFE. A same-session trade measured on a daily bar leans the same way (its MFE is
that day's high). Because the bound only ever favours the full target, exactly one inference is
drawn from it.

### The pre-committed reading

After **30** measured tightened trades (`MIN_LEDGER_TRADES`): if the optimistic counterfactual
beats realized R with a bootstrap 95% CI that excludes zero, the tighten has a real cost → set
`mlRegimeTargetTightenPct` to 0 and re-run the walk-forward grid; if it does not, the tighten is
kept — an optimistic counterfactual that cannot beat it is strong evidence for it. The reverse
inference ("the counterfactual lost, so the tighten helped by that much") is never drawn. The
route reports the reading in those words (`reading`, `readingDetail`) so it is read, not
re-derived.

### What this does NOT do

- It does not change any trade, target or setting — a report, read by a person.
- It does not measure options trades or the size cut, and it has no control group.
- It does not run on the dashboard poll: the count is cheap, the ledger is on demand.

## 2026-09-08 — backtest parity for the overlay, and the grid that decides it

**What shipped.** `BacktestRiskParams` carries the overlay's four fields (`mlRegimeEnabled`
false, cut 35, tighten 30, bar 0 — the live defaults, inert), and both equity engines
(`backtest.ts`, `combinedBacktest.ts`'s equity leg) replay it from the walk-forward regime
history through three shared helpers: `backtestDayRegime` reads the PREVIOUS trading session's
label (the history is keyed by data date; FRED publishes a close the next morning — no day is
labelled by its own close), `backtestDayDecisionConfig` tightens the day's `targetRMultiple`
through `regimeAdjustedTargets`, and `withHighVolFloor` raises the screen's `minScore` to the
conviction bar on a regime day through `highVolScoreBar`; the size cut rides the risk check's
own `regimeTriggers`, so a cut of 100 refuses the entry exactly as it does live. Unknown fails
open, the nowcast is excluded (a daily bar knows its full range only at the close), the
combined engine's options leg is cut but not tightened (its exit rule reads the config at exit,
not a stamp), and the standalone options engine stays inert — the overlay's evidence is the
equity grid. `loadMlRegimeByDate` is consulted only with the overlay on and fails loudly
without the history (`npm run regime:evaluate`). Reports carry `regimeDayTrades` (fills whose
signal day read High Vol). The routes accept the four fields; the flag alone runs the LIVE
config's numbers (`mlRegimeBacktestFields`, the weight-preset convention), the research grid
sends every number. The backtest form gained the checkbox.

**The grid** (`researchSweep.ts`, `npm run research -- --experiments mlregime`, opt-in): stage 1
cut × tighten (15 cells, 0/0 byte-identical to the baseline with the overlay OFF), stage 2 the
conviction bar {off, 72, 76} at the chosen cell. `selectOverlayCell` is the rule as code:
highest OOS return ÷ max drawdown (% of starting equity) among cells keeping ≥ 75% of the
baseline's OOS return; ties → smaller cut, smaller tighten, lower floor; nothing beating the
baseline's ratio → OFF. A non-positive baseline return makes the 75% clause vacuous — a cell
must then simply not be worse. The script prints both stages and writes the selection into its
results file; the cell that ships ON is recorded below, in a dated row, before the config
changes.

### What this does NOT do

- It does not run the grid — that needs a running instance with historical bars and the
  regime history, and it is the operator's step; no cell has been chosen yet, so every
  overlay field stays at its shipped default (OFF).
- It does not replay the nowcast, the daily goal, the ledger, or the standalone options
  engine, and it does not tighten the combined engine's options leg.

### The decision-log row (filled in by the first run)

| date       | window / split                            | symbols                                                                                                                     | chosen cell         | baseline ret% / DD% / ratio | chosen ret% / DD% / ratio | note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-10 | 2024-09-03 → 2026-09-03, split 2025-12-01 | 50 names: the live book's most-traded (64 distinct live+autotrade symbols, so none of the README's ten were needed as fill) | cut 50 / tighten 15 | 21.24 / 4.74 / 4.48         | 33.71 / 3.04 / 11.10      | stage 1: cut 50 / tighten 15: OOS return 33.71% over a 3.04% max drawdown (ratio 11.10) beats the baseline's 21.24% / 4.74% (ratio 4.48) while keeping ≥ 75% of its return; ties break toward the smaller cut, then tighten, then floor. Stage 2 (the conviction bar at that cell): no cell beats the baseline (33.71% over a 3.04% max drawdown, ratio 11.10) on OOS return ÷ max drawdown while keeping ≥ 75% of its return — the overlay stays OFF — read as: no floor; the stage-1 cell stands with floor 0 |

The row implies `mlRegimeSizeCutPct` 50, `mlRegimeTargetTightenPct` 15 and
`mlRegimeHighVolMinSignalScore` 0 (stage 2 found floor 72 identical to no floor in return,
drawdown and trade count, and floor 76 below the 75% keep-share, so no floor is chosen). The
overlay stays OFF until the operator sets these and every other enabling rule is met — rule 1
of the four pre-committed enabling rules (2026-09-08, "an HMM market-regime reading, as an
observer") is now answered; rules 2–4 are not, and the Auto page's overlay checkbox says to
leave it off until the model card's enabling rules are met. The run itself is
`ml/reports/regime-grid-2026-09-10.json` and `.log` (18 walk-forward runs, no data issues
reported; a 50-symbol book, one history, no multiple-comparisons correction — a hypothesis to
confirm forward, per the script's own discipline notes).
---

## 2026-09-08 — the OTOCO probe: two findings, neither of them the one it was for

The plan was narrow. Place a second, standalone bracket group on a symbol that
already carried one, and count the resting combo groups. Four legs across two
`combo_order_id` values would have proved per-lot brackets are placeable and
settled a design question that had been open since 09-02.

The probe never got that far, and what it hit instead is more useful.

### Finding 1 — `held` was never the broker's bound

FCX was open: 38 shares, one combo group, a stop at 77.34 and a target at 80.05.
A **one share** protective bracket with deliberately unreachable prices was
refused outright:

```
OPENAPI_ORDER_NOT_SUPPORT_REVERSE_OPTION
This order cannot be entered because it will reverse an existing position.
You may need to close an open position, or cancel an open order, before you
can submit this order.
```

One share against thirty-eight held is not a reversal by any reading of the
holding alone. *"or cancel an open order"* is the half that explains it: the
broker compares a new protective order against the shares held **minus the
shares already committed to resting exits**. FCX had a full-size bracket
resting, so the available quantity was zero and no protective order of any size
could be added.

Two counting rules follow, and the same book evidences both:

| Scope | Rule | Evidence |
|---|---|---|
| Within one combo group | take the **max** leg, not the sum | a 38-share stop and a 38-share target rest together over 38 held, accepted at entry |
| Across combo groups | **sum** them | 38 committed plus a new 1-share group was refused as a reversal |

`committedProtectiveQuantity` in `providers/webull/orders.ts` implements exactly
that, and the standalone-bracket route now refuses against `held - committed`
with both numbers named, rather than passing a doomed order to the broker and
relaying a string that sounds like the position is wrong.

Three consequences worth stating plainly, because they decide designs:

- **You cannot place a replacement bracket before cancelling the old one.**
  Cancel-then-place is not a stylistic preference, it is the only ordering this
  broker permits. `cancelReplaceBracket` already does it in that order, so the
  naked window between the two is **structural**, not an implementation flaw to
  be engineered away.
- **The two-lot design still fits — with zero headroom.** Nineteen plus
  nineteen over thirty-eight held is exactly the bound, not comfortably inside
  it. A partial fill, or a race where the entry is not yet booked when the
  second bracket goes out, refuses that bracket and leaves those shares naked.
  Any build of it needs the second placement's failure path designed first.
- **The probe did not refute per-lot brackets.** It sent 39 shares of exits
  against 38 held, which the design never would. The question of whether two
  combo groups can coexist on one symbol is still open, and answering it needs
  either an account holding shares with no resting bracket, or the design built
  and tried at entry.

### Finding 2 — the scale-out's "fix" did not work, and nobody looked for four days

Chasing the refusal into the journal turned up something worse. The 144
`live_scale_out_blocked` events split cleanly on the day the both-legs replace
request shipped:

| Window | Refusals | Request shape |
|---|---|---|
| 09-02 .. 09-03 | 98 | one leg per request (the original bug) |
| 09-04 .. 09-08 | 46 | **both legs in one request** |

Same broker message on both sides of the split, verbatim: *"The number of
take-profit orders and the number of stop-loss orders must be the same."* The
46 later attempts span SMCI, IOT, DELL and FCX over five sessions, and each one
sends exactly one `STOP_LOSS` and one `STOP_PROFIT` — the balance the message
asks for. Scale-out fills to date: still **zero**.

The diagnosis was right and the remedy was wrong.

**But the endpoint is not broken.** FCX's stop ratcheted three times in four
minutes the same morning — 77.34 to 77.35 to 77.41 to 77.44, all inside the same
combo group — and `live_stop_adjust_failed` has *never* been journalled, across
DELL, SNDK, IOT, SMCI and FCX. That path calls `webullReplaceOrder` (singular),
which delegates to this very function with a one-element array. So
`/order/replace` works; it refuses this particular request.

That also kills the first suspect. The resting group's **FILLED MASTER** leg
looked like the obvious culprit, and it cannot be: the MASTER is equally present
every time the stop ratchet succeeds. Three differences remain between the call
that works and the call that does not:

| | stop ratchet (works, always) | scale-out (refused, 46/46) |
|---|---|---|
| legs in `modify_orders` | one | two |
| what the patch changes | price | quantity |
| `client_combo_order_id` | not sent | **sent** |

### What shipped instead: the ratchet's shape, whole

Picking one of those three to change would have been the sixth guess in a row.
Every earlier one shipped the same way — a plausible reason, a unit test
asserting the new shape, and no check on what the broker did with it:

| Date | Added | Result |
|---|---|---|
| 09-03 | quantity only, one leg per request | 9 refusals |
| 09-04 | + the echoed defining price | refused |
| 09-04 | + `combo_type` | refused |
| 09-05 | + `order_type` | refused |
| 09-04+ | both legs in one request, + `client_combo_order_id` | 46 refusals |

So the resize now stops guessing and **copies the request that works**. The
ratchet sends the client order id and the single field it is changing —
`webullReplaceOrder(id, { stopPrice })` — and nothing else. The resize sends the
client order ids and `quantity`, and nothing else. No `combo_type`, no
`order_type`, no echoed price, no combo id. Two legs stay in one request,
because single-leg quantity modifies are what drew the original 98 refusals and
one leg alone genuinely does unbalance the pair the broker complains about.

Dropping the echoed price has a second benefit worth naming: the old payload put
a live protective price on the wire on every partial, to "identify" a leg the
client order id already identifies. A stale read or a typo there would have
moved a real stop.

### And the check that had to ship with it

`replaced.ok` means the broker ACCEPTED the request. It does not mean the
resting legs changed — the same distinction `verifyLegsGone` exists for on the
cancel side. The scale-out did not draw it: it went from a 200 straight to
selling the difference. **Had a modify ever been accepted without being applied,
that sale would have gone out against a full-size bracket still resting, and the
surplus sell shares are a short.**

That was latent only because the request was refused 148 times out of 148. The
moment the payload changes it stops being latent, so `verifyLegsResized` lands in
the same commit — it re-reads the book and confirms both legs carry the new size
*and* still carry their original prices before anything sells:

- **legs unchanged** → the broker no-opped. The bracket still covers the whole
  position, so the partial is skipped and nothing is naked. Journals
  `live_scale_out_blocked`.
- **legs changed into something else** — a moved price, a vanished leg, one leg
  applied and not the other → protection nobody chose. Journals
  `live_position_unprotected`, which pages, and sells nothing.

The price half also guards the one assumption the new payload rests on: that
`/order/replace` patches only the fields it is given. The ratchet evidences that
in one direction (it sends a price, no quantity, and the quantity survives); the
converse is assumed here and **checked rather than trusted**.

Cancel-and-replace is exempt, deliberately — it destroys those leg ids on
purpose and does its own verification, so checking for the old ids would condemn
its success as a vanished leg. That exemption was found by a consumer test, not
by reading the code.

### If this one also fails

Then the remaining difference from the ratchet is only the leg count and
quantity-vs-price, and the honest conclusion is that this broker does not
support resizing a resting combo leg at all. At that point the choice is between
cancel-and-replace's structural naked window and per-lot brackets at entry
(#26) — and it is a decision about which risk to take, not another payload.

The comment in `webullReplaceOrders` asserted the fix as settled fact. It has
been corrected in place, because a future reader would otherwise re-derive the
wrong conclusion from it.

**The process failure is the point.** The unit tests were green throughout, and
they were always going to be: they assert the *request shape*, which was never
in doubt. The broker's answer to that shape was the thing in question, and only
production could give it. This is CLAUDE.md's rule verbatim — *if a change
should move a user-visible number, go look at that number* — and the number
here was "scale-out fills", which sat at zero for four days while the code said
the problem was solved.

### Where this leaves the scale-out

Three candidate paths, and the probe removed one of them:

1. **Modify the resting legs** — 144 refusals, 0 fills, dead unless the FILLED
   MASTER theory pans out. Not to be re-enabled on hope.
2. **Cancel then place** (`liveScaleOutCancelReplaceEnabled`, still off) — uses
   the place path, so Finding 2 does not touch it, and Finding 1 confirms its
   ordering is the only legal one. Its naked window is structural.
3. **Two brackets at entry** — untested, fits the quantity bound exactly, and
   needs the second-placement failure path designed before any build.

No config was changed. The test order was refused, so nothing rested in the
book and there was nothing to cancel; FCX finished the probe with its original
three legs and its protection intact.

---

## 2026-09-08 — the naked-position alarm was paging on stops that had just filled

`checkLiveBracketProtection` asked one question: is there a resting exit-side
order on this symbol? A `no` was treated as "unprotected, wake someone".

But a bracket whose stop has just **filled** answers `no` too. The two states
are identical from the open-orders book, and the alarm could not tell them
apart. On 09-08 it paged on SMCI:

```
13:52:45  live_position_unprotected — "the broker shows no resting sell order on
          SMCI — its stop may never have been accepted, or was cancelled. Check
          the broker and re-arm protection by hand."  restingExitLegs 0
13:52:53  position_reconcile_skipped — bracket_leg_reconcile_pending, brokerQty 0
13:54     exit recorded: exitReason 'stop', 52 @ 40.77
```

Nothing was ever unprotected. The stop was in the act of working, and the
reconcile knew it eight seconds later — `brokerQty 0` is the position being
**gone**, not naked.

### The fix

The alarm now reads the held quantity before it pages, and only on the branch
that is about to page — every position that still has its stop returns earlier,
so this costs one account read per position genuinely at risk, not one per
position per tick.

| Broker says held | Verdict |
|---|---|
| 0 | closed, not unprotected. Skipped, and the reconcile will book it. |
| more than 0 | real. Pages, and the detail names the confirmed count. |
| read failed | still pages — fail-loud is right for a protection alarm — but the message says the held count is **unconfirmed** rather than claiming it. |

A partial fill lands in the second row correctly: the shares that remain
genuinely have no stop under them.

### Why it was worth fixing on one instance

Seven `live_position_unprotected` rows exist in the whole journal. Exactly
**one** is a confirmed false page — today's SMCI, followed by a `stop` exit the
same day. The other six exited with no recorded reason, so they cannot be
classified either way and no rate should be claimed from them.

The argument is not the count. It is that **this is the alarm that pages**, its
text tells the operator to go re-arm protection by hand, and it fires on a state
that occurs every single time a stop does its job. Left alone it would page on
every stop fill from here on, and an alarm that cries wolf on healthy positions
trains you to ignore the one case it exists for — the same reasoning already
written into this function for account scoping and for parse misses.

---

## 2026-09-08 — a read-only way to ask what the broker holds

There wasn't one. The question came up three times in a single session and every
time the answer had to be inferred from a side effect:

| Incident | How the held quantity was actually obtained |
|---|---|
| SMCI mid-adoption | read off a `position_reconcile_skipped` detail |
| FCX bracket probe | the broker's own rejection string |
| NOK scale-out remainder | a deliberately oversized protective order, sent so its own guard would refuse it and name the count |

That last one is the tell. It is a **read dressed as a write** — an order
placement endpoint invoked with a quantity chosen to be refused — and it was
blocked by a permission classifier, correctly. Nothing about the shape of that
request says "I only want to look".

`GET /api/autotrade/live/holdings` is the read. It calls
`previewWebullPositions`, which fetches `/openapi/assets/positions` and maps it
without writing anything, and rolls the equity rows up per symbol.
`?symbol=NOK` answers the single-symbol question directly, which is the form
every one of the three incidents actually needed.

### The one thing it must never get wrong

A broker row the mapper cannot parse **still proves the account holds something
in that symbol**. Reporting such a symbol as quantity 0 would be exactly the
false negative this endpoint exists to prevent — and it is the same trap the
close-detector already guards with its `unmappedSymbols` freeze list, where an
unparseable row must never be read as evidence of a sale.

So unmapped symbols are surfaced separately (`unknownSymbols`), and the
single-symbol form returns `known: false` alongside the zero. Callers must read
that as *held, quantity unknown* — never as flat. An unreadable broker is a 502,
not an empty list, for the same reason.

Option rows are excluded from the share roll-up: an option row's quantity is
contracts on one specific contract, and summing it beside share counts produces
a number that means nothing.

### Why it matters beyond convenience

Zero resting exit legs looks identical whether a stop was never accepted or has
just **filled**. The held quantity is the only thing that separates them — the
same distinction that made the naked-position alarm page on a stop that was in
the act of working, earlier the same day. Until this endpoint existed, the only
component that could ask the question directly was the alarm itself.

---

## 2026-09-08 — a booked exit pinned its position against the broker-truth sync

The first live cancel-and-replace scale-out ran at 16:36Z. Within minutes NOK 600
was flat at the broker and still open in the journal, and it stayed that way for
an hour — holding one of three concurrency slots, against a 3%/day target sitting
at 0.53% with two hours of session left. Nothing was unprotected; this cost
opportunity, not money.

### The cycle

`runWebullPositionsSync` refuses to close a position while the loop has a closing
order in flight for it — the 2026-08-24 fix, which exists because this sync was
beating the loop's own reconcile to a fill and booking a *quoted estimate* over a
real price, losing both fidelity and the exit reason (VALE, then DELL 587).

It decided "in flight" by membership of `listPendingLiveOrders()`. But that query
deliberately keeps a **filled** exit row alive while its position is open, so
`reconcileLiveOrders` can still work with it. Read as "in flight", that is
circular:

```
position stays open  ->  because the sync defers
sync defers          ->  because the exit row is pending
exit row is pending  ->  because the position is open
```

The bracket-leg defer directly above it is bounded by the miss streak and
self-releases. This branch has **no bound at all**.

### Why it had never fired before

It needed a **partial** exit to exist. A full exit's reconcile closes the
position, which drops its row out of the pending list and ends the cycle. A
partial books its slice and *correctly* leaves the position open — and from that
moment its filled exit row pins the position permanently.

No partial had ever executed. The scale-out had been refused ~150 times across
six payload shapes and had never once filled. **The bug shipped long ago and was
unreachable until the day the scale-out started working.**

### The fix

Filter on the intent's own state (`isTerminal`) rather than on membership of a
list that answers a different question. A filled exit has already been booked by
whoever placed it — which is the entire point of deferring — so it has no claim
to defer any longer. An exit still `submitted` or `acknowledged` defers exactly
as before.

### And the reason it hid for an hour

The journal row for this branch is gated on `justConfirmed`, which is true only on
the sync that first crosses the miss threshold. NOK spent its early syncs in the
*bracket* branch, logged there once at streak 2, then fell through to this branch
at streak 4+ where `justConfirmed` was already false — so it logged nothing, ever.
Every `position_reconcile_skipped` row in the journal reads "streak 2" for the
same reason, which makes them look like fresh defers no matter how old they are.

A defer that reaches `STUCK_DEFER_STREAK` (10 syncs, roughly twenty minutes) now
journals once, carrying the streak and an `overdue` flag. Keyed on **equality**,
not a threshold, so the streak passes through the value and it fires exactly once
per episode without needing state of its own. It **reports and does not act** —
the defer stays, a human decides. Shortening the grace window would reopen the
DELL bug; the defect was the release condition, never the deferral.

---

## Same-day re-entry size cut (2026-09-08)

`repeatEntrySizeCutPct`, default `0` (off). Live equity book only.

### The finding

Over 89 closed live-autotrade trades: first entries in a name **n=56, +$398.98
(mean +$7.12)**; same-day repeats **n=33, −$121.03 (mean −$3.67)**.

`symbolCooldown.ts` does not catch these and was never going to. It needs two
**losing** closed trades inside a rolling window measured in **calendar days**,
and the exit producing most of these repeats is the stagnation exit — which by
definition closes near scratch, so it is not a loss, never counts, and the
cooldown never engages. `reentryCooldown.ts` (`symbolReentryCooldownMinutes`)
does address the reflexive re-entry, but it ships at `0` and blocks outright,
which is a stronger claim than the data supports.

### Why a cut and not a block

The **direction** of the gap survives trimming; the **magnitude** does not. 86%
of the −$121.03 repeat deficit is a single DELL trade, and dropping the worst
trade from each side leaves repeats at **−$0.55 a trade**. And the counter-case
is on the record in `symbolCooldown.ts`'s own header: LVWR lost −0.98R at 12:30
and its same-day re-entry won +1.93R. So repeats are worth *less*, not
*nothing* — a trim is the honest expression of that, a block is not.

For the same reason the cut is **flat, not a ladder**: `isRepeatEntryActive` is
a boolean over the count, so the fourth attempt in a name is cut exactly as much
as the second. Compounding per prior exit was never measured, and third entries
are rare enough that a ladder would be tuned on almost no data.

### How it is counted

`sameDaySymbolExits(symbol, closedPositions, etDay)` in `reentryCooldown.ts`:

- **Positions, not exit rows.** A scaled-out trade books a partial exit and a
  final exit on the same day. Counting rows would score that single trade as two
  repeats and cut the next entry twice as hard for no reason — and since the
  scale-out started filling on 2026-09-05, that is now the ordinary shape of a
  live trade, not an edge case.
- **Exits, not entries.** A position opened yesterday and closed this morning
  makes this morning's second attempt a repeat; entry-counting would miss it.
- **The ET trading date, not a rolling 24h window.** The finding is about
  re-entering inside the same *session*. An overnight gap resets the thesis, and
  a wall-clock window would keep yesterday afternoon's exit suppressing this
  morning's first entry.

### Wiring

- `SizingFactors` gains a required `repeatEntry` field, so neither risk check
  compiles until both books state what it does. It is the **seventh**
  multiplicative factor; `effectiveRiskPct` multiplies it with the rest.
- `liveExecute.ts` derives `priorSameDayExits` **once per signal** and passes
  the same value to `preFinishLineFactors` and to `RiskCheckContext` — the
  finish-line trim and the sizer must reason about the same count.
- The closed-position read is shared with the re-entry cooldown behind an **OR**
  (`symbolReentryCooldownMinutes > 0 || repeatEntrySizeCutPct > 0`). Tying it to
  either feature's own setting would hand the other an empty list and it would
  do nothing, silently.
- `evaluateRiskCheck` emits a `repeat_entry_sizing` check derived from the
  **factor**, not the trigger, so a 0% cut reads `triggered … size unchanged`
  rather than `active` — the `regime_sizing` lie of 2026-09-05, avoided by
  construction.

### Scope: LIVE only, by decision

Paper passes `priorSameDayExits: 0` **and** `repeatEntrySizeCutPct: 0`, with the
reason written at the call site: this finding gets re-measured at ~60 repeats,
and paper is the arm it gets re-measured *against*. A control arm that takes the
same treatment as the test arm cannot settle anything. Both options books and
all three backtest engines opt out the same way, each with its own note.

### What the tests assert

At the **consumer**, throughout — `evaluateRiskCheck`'s `suggestedQuantity` and
the quantity that reaches `webullPlaceOrder`, never the factor. That is not
ceremony: this feature's own first draft computed `repeatEntry` in
`preFinishLineFactors` and left it out of `effectiveRiskPct`'s product, and
every unit test on the builder stayed green. The generalised guard in
`effectiveRisk.test.ts` — set each `SizingFactors` key to 0.5 alone and the
result must halve — is what catches that class of defect for the next factor
too, since the required-field type forces the new key into the fixture it
iterates.

The live-path tests measure their own full-size baseline rather than hardcoding
a share count: live probation is halving the same orders, and a literal would
quietly start asserting the probation factor the day either number moves.

---

## Relative-volume PACE scoring (2026-09-08)

`relVolUsePaceScoring` (default `false`) and `relVolPaceTarget` (default `2.5`).

### The gap this closes

`minRelVolPace` replaced raw relative volume for the entry **gate** on
2026-08-25. The **score** was never touched, so `scoreRelVol` still reads raw
`relVolume` — today's cumulative volume over an average FULL day, which climbs
mechanically through the session.

The consequence, measured on the live book: **8 of 15 entries scored exactly 0**
on the relative-volume component, which carries **20% of the weight** by
default. Not because those names were quiet — because before roughly midday
almost nothing can reach `relVolTarget` (2×), so the component says
"unremarkable" about every stock in the market at the same time. At 10:47 ET on
2026-08-25 the median of 261 scored symbols read `0.10` and exactly one reached
`1.0`.

### The scoring

`scale01(relVolPace, 1.0, relVolPaceTarget)`.

The floor is **1.0 pace, not 0.5**. A stock at 1.0 is keeping up with the median
stock, which half the universe does by definition, so it earns nothing. That is
a different number in a different unit from the raw branch's 0.5 floor, and the
two must never be swapped — hence `PACE_UNREMARKABLE` as a named constant beside
a comment saying so.

`relVolPaceTarget` is likewise **not** `relVolTarget`. One is a multiple of the
market's current pace, the other a multiple of the symbol's own 20-day average;
both are plain positive numbers, so reading the wrong one would be silent. The
default 2.5 puts full marks at about the 95th percentile of the pace
distribution — the same "clearly unusual, not merely above average" place
`relVolTarget` occupies in its own units.

**Falls back to the raw measure when the pace is unmeasurable** (fewer than
`MIN_PACE_SAMPLES` = 20 usable symbols this tick, or no `relVolume` for this
symbol) — never to 0. Scoring 0 is precisely what this change exists to stop
doing, and a thin tick reintroducing it under a different cause would be no
better.

### Ordering: why the screen now scores after the fetch loop, not inside it

The pace needs the universe median, and the median needs every symbol's
`relVolume` — so **no symbol can be scored until all of them have been read**.
`computeIndicators` therefore always sets `relVolPace: null` (it sees one symbol
and cannot know better), the fetch loop retains each snapshot, and scoring runs
once afterwards. Snapshots are flat objects of ~17 numbers; holding 560 of them
is nothing next to the candle arrays already live during the fetch.

`selectFromSnapshot` is the single implementation of "score this snapshot, pick
a direction, else record a rejection", called for both scorings. Two copies that
agree today would drift, and the drift would be invisible in the worst possible
way: flag-on and flag-off differing for reasons unrelated to the flag, in the
middle of the measurement meant to decide whether to keep the flag on.

### Why a flag, and why it ships off

Turning this on rescales the entire score distribution. `liveMinSignalScore`
(72) was fitted to the **raw** distribution against realized P&L in PR #44 —
enabling pace scoring without re-fitting that floor moves the live entry gate
without anyone deciding to.

So the flag is off **and both scorings are computed every tick**, with one
aggregate row journaled as `relvol_pace_scoring_shadow`:

| field | meaning |
|---|---|
| `enabled` | which scoring is live |
| `universeMedian` | the denominator; `null` when unmeasurable |
| `compared` | scored symbols, **including those that failed filters** |
| `relVolComponentZeroRaw` / `…Pace` | the headline: how many score 0 on the component under each |
| `meanTotalDelta` | mean change in total score |
| `wouldNewlyPass` / `wouldNewlyFail` | the **set** change — an average can be flat while the candidate set turns over completely |

One row per tick, not one per symbol: `excluded_re`'s per-tick volume is already
an open question (task #43), and this must not add to it.

The counts cover **every scored symbol, not just the survivors**. Restricting
them to candidates would measure the component exactly where the rest of the
score already carried the symbol through, and would report a shrinking sample as
the score floor rises — the moment the measurement matters most.

### Deciding it

Read a few sessions of `relvol_pace_scoring_shadow`. If `wouldNewlyPass` and
`wouldNewlyFail` are both small the change is cosmetic and the flag is not worth
the risk. If the set turns over materially, then `liveMinSignalScore` has to be
re-fitted against the pace-scored distribution **before** the flag goes on — not
after.

**Since 2026-09-12 the edge-leak scan reads it, and the reading is done** — see
the dated section below. The answer was not cosmetic: about **15 symbols newly
pass per tick against 0.3 newly failing**. The re-fit comes first.

---

## Raising the excursion cap, and what it did NOT unblock (2026-09-08, corrected 2026-09-09)

`GET /api/journal/excursions` capped its analysis at **50** trades. The book held
117 closed stock trades: 25 undated (genuinely unmeasurable — an excursion walks
candles from the entry), leaving **92 measurable**, of which **42 were reported
as `overCap`**. The report was honest about dropping them; nothing was hidden.
It was still analysing barely half the evidence.

That mattered the moment task #32's gate was reached. With 24 winners the
target-multiple question became answerable, so the counterfactual was run: for
each trade, if its MFE reached candidate target `T` it exits at `+T`, otherwise
it keeps the outcome it actually had.

| T | hit % | mean R | paired Δ vs 2.0R | trades that differ |
|---|---|---|---|---|
| 0.5 | 35% | +0.120 | −0.023 (t −0.37) | 17 |
| 1.0 | 12% | +0.111 | −0.032 (t −0.77) | 6 |
| 1.5 | 8% | +0.122 | −0.021 (t −1.06) | 4 |
| **2.0** | 6% | **+0.143** | baseline | — |
| 2.5 | 4% | +0.165 | +0.022 (t +1.53) | 3 |

**Verdict: HOLD at 2.0.** Every alternative sits inside noise — all |t| < 2, every
95% CI straddles zero — and above 1.25R only three or four trades differ at all.

**The naive read is backwards**, which is why it is written down here. "Only 12%
of winners reach 2R, so lower the target" would have *cost* expectancy: median
realized R is 0.00, so the book is carried by a thin tail, and a lower target
clips exactly that tail while changing nothing for the trades that exit by stop,
trail or stagnation anyway.

### What changed

- `EXCURSION_TRADE_CAP` 50 → **250**, so the whole measurable book is analysed.
- **`?limit=`** narrows it on demand, clamped to the cap, so a growing book never
  needs a deploy to be measured — and a junk limit (`abc`, `0`, `-5`, empty)
  falls back to the full cap rather than to `slice(0, NaN)`, which returns an
  empty array and would have reported a clean zero-trade analysis.
- Fetches now run through **`mapPool` at 6**, not `Promise.all` over everything.
  Raising the cap without this would have fired 92+ concurrent candle requests at
  a provider that already costs the screener ~47 of 559 symbols a tick to rate
  limiting — and a throttled fetch here does not fail loudly, it lands in
  `unavailable` and *shrinks* the sample, which is the exact opposite of the point.

### Still open

Winners capture a median **48%** of their peak favourable move. That is an EXIT
question — trail, stagnation, scale-out — not a target question, and it belongs
with the exit-tuning work rather than here.


---

## Correction: the cap was not the binding constraint (2026-09-09)

The section above claims raising `EXCURSION_TRADE_CAP` unblocked task #32's
target-multiple question. **It did not, and the claim was wrong when written.**

Re-run on the uncapped route: the sample went 50 → 92 rows, but the *usable*
sample went **46 → 48**. Every one of the 27 added trades falls back to **daily**
bars.

| resolution | n | entry dates | mfeR median | mfeR max | reached 2.0R |
|---|---|---|---|---|---|
| intraday | 48 | 2026-07-15 → 09-08 | 0.34 | 2.60 | 3 (6%) |
| daily | 31 | 2026-07-09 → 08-24 | 1.29 | **55.51** | 11 (35%) |

The daily rows are the **older** trades: the provider's intraday history reaches
back to roughly 2026-07-15 and no further. So the binding constraint is the
**intraday history horizon**, not a constant — and more evidence for this
question can only come from time passing.

A daily-bar MFE is the high across whole calendar days, not the excursion during
the hold. Worst case in the sample: ELAB entered 2026-07-10, `mfeR 55.51`,
`mfePct 979.58` — a penny stock's multi-day range, not a day trade's excursion.
Pooled, the 92-row run reported 35% of trades reaching 1.0R where the intraday
truth is 15%.

**The HOLD at 2.0 stands** — on the intraday subset the picture is unchanged, 6%
reach 2.0R and every candidate target stays inside noise.

### The regression this exposed

Raising the cap took daily rows from 4/50 (8%) to 31/79 (39%), and the report's
pooled averages moved with them — `avgMfeR` 0.70 → **1.74** without a single
trade changing. Measured apart: **intraday 0.54, daily 3.60**. `resolutionMix`
disclosed that a mix existed, which was enough while daily rows were a rounding
error and stopped being enough the moment they were a third of the sample.

`aggregateExcursions` now also returns **`byResolution`** — the same four
averages computed separately, from the same partition `resolutionMix` counts, via
one `averagesOf` both paths call. The pooled fields stay (callers read them, and
"across everything measured" is still a real answer), but anything denominated in
R should read `byResolution.intraday`. The Journal analytics modal shows the
split beneath the tiles for the same reason.

### Known, unfixed at the time: `computeExcursionTune` did not filter by resolution

**Fixed 2026-09-09 — see "the exit auto-tune's three preconditions" at the end of
this document.** The tuner now reads intraday rows only, `autoTuneExitTunedAt` is
stamped by every writer of the geometry (not just the tuner), and
`autoTuneExitsEnabled` is OFF. The rest of this section is the reasoning as it
stood, kept because the "non-binding, not correct" distinction is the reason the
fix is not on its own sufficient.

`excursionTune.ts` derives `targetRMultiple` from `avgMfeR` over winners and
`stopAtrMultiple` from their MAE percentile, with **no resolution filter**, so an
inflated daily MFE can reach live exit geometry. Two things bound it today, and
neither is a fix:

- `TARGET_R_MIN/MAX` (1..6) and `stepToward(maxStep)` clamp any single run.
- Simulated on the current book it proposes the *same* `targetRMultiple 1.75` /
  `stopAtrMultiple 1.25` whether daily winners are included (n=30, avgMfeR 1.43)
  or excluded (n=22, avgMfeR 0.75) — both raw targets land on the `TARGET_R_MIN`
  floor, and the step limit caps the move either way.

So it was **non-binding, not correct**. `sampleSince` would normally exclude the
older daily rows, but `autoTuneExitTunedAt` was `0` in production, so that filter
admitted everything. Left as an operator decision rather than changed under them
while it was a live-money path — the flag has since been turned off (task #47)
and both defects fixed (task #58).

---

## Exit-rule path replay (2026-09-09)

`GET /api/journal/exit-replay` — walks each same-session trade's 5-minute bars
**in order** against a candidate exit geometry and reports where it would really
have been closed.

### Why /excursions cannot answer this

`computeExcursion` collapses a trade to its high and low. It answers "how far did
this run" and structurally cannot answer "would a tighter stop have survived the
dip that came first". Reasoning about exit rules from MFE alone is not merely
imprecise — it is **biased, always in the same direction**. Model a trail as
"exit at peak − D" and it can never be punished for tightening D, because a
peak-and-distance model contains no dip.

Run over the live book on 2026-09-09, that model reported every trail distance
from 0.5R down to 0.1R as monotonically better, mean R **+0.032 → +0.315**. That
is the signature of a question the data cannot answer, not a finding, and it was
discarded rather than acted on.

### What prompted it

Three live thresholds are all set at **0.5R**:

| setting | value | against this book |
|---|---|---|
| `trailStartRMultiple` | 0.5 | reached by only **17 of 48** intraday trades (35%) |
| `trailStopRMultiple` | 0.5 | the stop's distance behind the peak |
| `stagnationExitMinR` | 0.5 | below this for 90 min and the slot recycles |

The book's **median trade peaks at 0.34R** and its **median winner at 0.58R**. A
stop trailing 0.5R behind the peak of a 0.58R move sits at breakeven — which is
exactly what IOT (peak 1.04R, booked 0.25R) and TSLA (peak 0.64R, booked 0.05R)
did. Those are arithmetic and need no simulation; choosing replacements does.

Also worth recording, because the framing was wrong first: the 48% median capture
is **not** the scale-out (only 3 of 22 winners had a partial fill — it began
working on 2026-09-08) and **not** mainly the trail (which rarely binds). The
dominant winner exit is `time_exit`, **12 of 22**, peaking at 0.54R and booking
0.30R. The clock closes them.

### Intrabar order is unknowable and is resolved ADVERSELY

Within one 5-minute bar the high and low are known; their order is not. Every
ambiguity is resolved **against** the trade: if the stop and the target both sit
inside one bar's range, the stop fills. That assumption is the point — a replay
whose assumptions all flatter the change under test is the peak-and-distance
model again, wearing more code.

### Scope and what it reports

Same-session trades only. An overnight hold has no usable intraday window, and
replaying it on daily bars would degenerate into the very model this replaces —
so it is **excluded and counted** (`coverage.notSameSession`), never dropped.
Coverage buckets sum to the whole population, as on `/excursions`.

Rule defaults come from the **live config**, so a bare call answers "what would
today's geometry have done"; `?breakevenR=`, `?trailStartR=`, `?trailStopR=`,
`?targetR=` each answer "what would this one change". Junk falls back to the live
value rather than to `NaN`, which would silently disable the rule it belongs to
since every comparison against NaN is false. The response pairs the replay
against the **actual realized R on the same trades** — comparing a replay over
one population to a headline average over another is how a rule change comes to
look like an improvement it never made.

### Not yet done

Nothing has been tuned from this. The replay is the instrument; running the grid
and deciding the three 0.5R thresholds is the next step, and `autoTuneExitsEnabled`
stays off until it has been done (task #58).


---

## Two attributions of realized R, and why they don't reconcile (2026-09-09)

Reading the live sweep, `realized.avgR × realized.rTrades` came to **1.00R**
while `actual.totalR` read **1.65R** in the same payload. That looks exactly
like a defect and is not one — they are attributed differently, and both are
right for what they answer.

| | attributed to | over which sessions |
|---|---|---|
| `realized.avgR` | the **entry** | every closed trade in the window |
| `actual.totalR` | the **exit** | **active** sessions only |

`tradesPerSession × avgR` is a forward identity: on a day the book trades it
makes N entries, and each will eventually realize `avgR`. Every trade is
entered on a session that has entries — and so is active by definition — so
both factors come from the same population even though only one of them
mentions sessions.

`actual.totalR` is a policy **baseline**. A session with no entries cannot be
changed by a stopping rule, so including it would add the same constant to the
baseline and to every level, and the deltas are the whole point. The ~0.65R gap
on the live book is exits landing on sessions that had no entries of their own —
trades opened the day before, which are net negative there.

`totalRAllSessions` was added so this is visible rather than something a reader
has to derive. It equals `avgR × rTrades` (to rounding) and is used by nothing:
the baseline and every level must share one session set.

### What this does NOT change

`impliedDailyGainPct` stays as it was. It reads **0.07%** against a stored 3%
goal — `targetOverImplied ≈ 43` — and the mismatch above is not a reason to
doubt it. Recomputing the live book by hand agrees: same-session stock trades
average **+0.033R** (n=48), overnight ones **−0.030R** (n=29), all live stock
**+0.009R** (n=77) against the sweep's 0.013.

A first pass at this reported **+0.105R** and read as though the dashboard were
understating the edge by an order of magnitude. That figure covered only the 45
trades carrying an `entryScore`, and the three it dropped lack a score *because
they predate score stamping* — all three were near-full losers (−0.98, −1.21,
−1.00). Filtering on a field correlated with age, where age correlates with
outcome, is selection. The correction is recorded here because the wrong number
briefly looked like good news.

---

## Per-lot protective brackets — the planner (2026-09-09, task #26)

`services/autotrading/perLotBrackets.ts`. **Pure and not yet wired**: nothing
places these orders. The placement path needs a live entry to answer the one
question the design still has open, and this is the half that can be built and
tested without one.

### Why two brackets at entry

Three ways to take a partial out of one bracket have been tried:

| approach | outcome |
|---|---|
| modify the resting legs | 144 refusals, 0 fills — dead (#54) |
| cancel then place | ships and works (#29/#31), but the window between the cancel and the replace is **structural** — if the replace fails, the remainder rests naked. Live today, disclosed, not fixed |
| **two brackets at entry** | this module |

With the scale-out placed as its own bracket group at entry, taking a partial is
just that group's target filling. No modify, no cancel, no window.

### The bound, and the part still unknown

From the 2026-09-08 FCX probe, encoded in `committedProtectiveQuantity`: a new
protective order is compared against **held minus already-committed**. Within one
combo group the **max** leg counts; **across** groups they **sum**. So two lots of
19 over 38 held sit *exactly* on the bound with zero headroom — and anything that
makes the held count smaller at the moment the second bracket goes out (a partial
fill, an entry not yet booked) refuses it. `lotsFitProtectiveBound` checks this
before either order is sent.

**Answered 2026-09-09 — see the SIRI probe below.** That bound is the STANDALONE
rule and does not govern the OTOCO entry path, so `lotsFitProtectiveBound` must
not gate it. It remains correct for the re-arm endpoint.

### The failure branch, designed before the build

`classifySecondBracketRefusal` turns the probe into a decision. A
reverse-position refusal on the **second** bracket, when the arithmetic already
fits, can only mean the broker is counting the **first** bracket against us — the
group-count answer. That is a fact about the account, not a transient, so it
**does not retry**. Anything else gets one retry; a second failure falls back
regardless, because one lot protected and one naked is not a state to keep
probing from.

`planRollbackToSingle` then returns to **one full-size bracket — today's
behaviour** — so the failure mode is never worse than the status quo. It reports
`reopensNakedWindow` rather than leaving the caller to infer it: the first
bracket must be cancelled *before* the full one is placed, because the broker
counts it against the new order. That window is accepted only on the branch where
two groups have already been refused.

### Degenerate cases collapse to one lot

Quantity below 2, `partialExitPct` at 0 or ≥ 100, no near target, or a percentage
that rounds either lot to zero — all return a single lot, which is current
behaviour. The single lot is always the **runner** at the full target: if only one
bracket can exist it must not cap the trade at 0.25R. Lots always sum to the
**filled** quantity, checked exhaustively from 1 to 200 shares, since a plan that
sums high is refused and one that sums low leaves shares unprotected.

---

## 2026-09-09 — the exit auto-tune's three preconditions (task #58)

`autoTuneExitsEnabled` is **off in production** (task #47) because
`computeExcursionTune` converges to *both* its safety clamps in about five 0.25
steps: `stopAtrMultiple` 1.5 → **0.50** (`STOP_MULT_MIN`) and `targetRMultiple`
2.0 → **1.00–1.15** (`TARGET_R_MIN`). A 3× tightening of the stop, reached in
increments small enough that no single day's run looks alarming.

Three things had to exist before that switch could be argued about again. All
three now do; **the switch stays off**, because the third one is a measurement
and it has not been read yet.

### (a) The tuner reads INTRADAY rows only

`computeExcursionTune` took every row in the report. A daily-bar row's `mfeR` and
`maeR` are that whole *calendar day's* high and low — including the hours the
position did not exist — which for a loop running `maxHoldDays 1` and a 90-minute
stagnation exit is most of them. On 2026-09-09's book the 79 measured rows split
48 intraday / 31 daily, and their mean MFE was **0.54R** and **3.60R**
respectively (worst single daily row: 55.51R, a penny stock held several days).
Averaging the two is not a noisier estimate of one quantity; it is the mean of
two different quantities.

The same partition now also feeds `diagnostics.capturePct`, which used to read
the *pooled* figure and print it beside two intraday-only averages.
`diagnostics.dailyExcluded` reports what was dropped, and a warning names it.

**This is a correctness fix and NOT a sufficiency argument.** Measured on the
same book, intraday-only (n=22 winners, avgMfeR 0.75, heat p90 0.32) walks to the
**same two clamps**. Re-enabling on (a) alone was the first instinct and it is
wrong.

### (b) `GET /api/journal/exit-tune-validation` — do the rules make money?

The two rules —

| | rule |
|---|---|
| target | `0.8 × mean winner MFE` |
| stop | `stopAtrMultiple × (winners' heat p90 × 1.1)` |

— have never been checked against a realized outcome. `liveMinSignalScore` was
fitted that way in PR #44; `targetRMultiple` was tested that way in task #32,
where **no candidate beat 2.0 outside noise and 1.0 was among the weaker
options** — so the target rule's own answer disagrees with the only direct
expectancy test that exists. The stop rule additionally reasons from a **censored
sample**: a winner's MAE is bounded by the very stop being tuned.

The route fits the rules on the older half of the same-session trades and replays
the newer half under what they produced, against the geometry actually traded,
using `exitReplay.ts`'s bar-path walk (never an MFE model — see that section
above for why a peak-minus-distance model reported every tightening as an
improvement and was discarded).

Two candidates are priced, not one:

- **one step** — what a single day's tune would do.
- **the fixed point** — where repeated runs come to rest if the trades keep
  looking like the ones recorded. That is the case worth pricing, because it is
  what actually happened. Each run is bounded to `maxStep`, so the strategy
  change is the *sum* of them and only the fixed point shows it.

**Units, since the two arms are denominated differently.** 1R is the trade's
initial risk in dollars. A candidate that tightens `stopAtrMultiple` makes 1R a
smaller *price* distance, and the sizer answers by buying more shares — because
`riskPerTradePct × equity` is what it holds fixed. So both arms' R are the same
number of dollars and their means compare directly; the replay is therefore run
with a **scaled stop price** rather than by rescaling results afterwards. Three
things that assumption ignores all **flatter the tighter candidate**: the extra
shares may not fit the per-order cap or buying power; `levelPlan` can override
the ATR stop on some trades; and intrabar order is resolved adversely. A
candidate that fails to win here fails on generous terms.

A directional verdict (`better` / `worse`) requires a **reliable** sample
(significance.ts's 20-trade floor) *and* a bootstrap CI on the paired
per-trade differences that excludes zero — the same pair of conditions
`checkOosEdgeConfirmation` uses. Below that it reports `insufficient` rather than
reading a confidence interval off four numbers.

### (c) `autoTuneExitTunedAt` is stamped by every writer

The field is documented as "when the exit geometry last changed" and the tuner
uses it to ignore trades taken under the previous geometry. **Only `autoTune.ts`
ever wrote it** — so a change made from the Settings page, which is how both
multiples actually got their current values, left the stamp behind and the next
tune judged the new geometry on trades taken under the old one. That is the
re-applied-correction loop `sampleSince` exists to prevent, entered through the
other door. It is now stamped in `setAutotradeConfig`, where every writer passes;
an explicit stamp in the patch still wins, so restoring a known state does not
date it to now.

Production read `autoTuneExitTunedAt: 0`, which is not "never" — it is a
timestamp older than every trade ever recorded, so `sampleSince` admitted the
entire journal. The cause: `Number(null)` is `0` and `Number.isFinite(0)` is
true, so `sanitize()` rewrote the default `null` to the epoch on the first read.
`null` now survives the round trip and a stored `0` reads back as the "never" it
always meant.

### The measurement, taken 2026-09-09

Run against the live book: 117 closed stock trades → **48 same-session
measurable** (25 undated, 32 not same-session, 12 with no intraday history
left). Carried rules from the live config: breakeven 0.25R, trail start 0.5R,
trail stop 0.5R.

**Out of sample — fit on 2026-07-15..09-02, scored on 09-02..09-08, 24 trades
each:** `no_change`. The training half holds **10 winners** against the live
`autoTuneMinTrades` of **20**, so the rule refuses to act at all. On a proper
walk-forward the tuner does nothing — not because the geometry fits, but
because the sample cannot support a fit.

**In sample — fit and scored on all 48, optimistic by construction:**

| candidate | geometry | mean R | vs current +0.08R | 95% CI | verdict |
|---|---|---|---|---|---|
| one step | stop 1.25 / target 1.75 | +0.10R | +0.02R | (−0.05, +0.08) | `inside_noise` |
| fixed point (5 runs) | **stop 0.50 / target 1.00** | +0.12R | +0.04R | (−0.13, +0.20) | `inside_noise` |

The fixed point reproduces task #47's finding exactly — five bounded steps to
**both clamps**. What it actually does is visible in the exit-reason mix:

| reason | current | converged |
|---|---|---|
| time_exit | 22 | 5 |
| stop | 1 | 8 |
| target | 1 | 11 |
| breakeven | 13 | 16 |
| trail | 11 | 8 |

It converts held trades into stops and targets — a **different strategy** — for
a difference indistinguishable from zero, on the arm that has already seen every
trade it is scored on.

### DECISION: `autoTuneExitsEnabled` stays OFF

The precondition was a `better` verdict on the fixed point, out of sample. What
came back was `no_change` out of sample and `inside_noise` in sample. Re-run
`/api/journal/exit-tune-validation` when a training half holds enough winners to
clear `minTrades`; until then the rule cannot be validated at all, and a rule
that walks to both clamps does not go back on unvalidated.

---

## 2026-09-09 — `excluded_re` is journaled once a day, not once a tick (task #43)

The autotrade journal is a table that **only ever grows** — `db/index.ts` says
so outright, there is no retention. It stood at **506,945 rows** growing
~21,300/day, and `excluded_re` ("Classified as real estate") was **155,162** of
them: 31% of the whole journal and 24% of daily growth. A 30-minute production
sample on 2026-09-04 held 500 of those rows across just **31 distinct symbols** —
the same static classification re-logged on every screener tick, of every
session, forever. The first entry says everything the 5,000th does.

`claimOncePerDay(action, symbol)` (`services/autotrading/oncePerDayEvents.ts`)
now gates both `excluded_re` sites. The row still lands **every day the fact is
true**, carrying `firstOfDay: true`, so "was PLD excluded on the 4th" stays
answerable; what stops being answerable is "how many *ticks* excluded PLD on the
4th", which is a question about the loop's cadence and is already answered by
`autotrade_last_tick` and the per-tick rows that remain.

**Not retention.** Deleting history is worse for a system whose whole point is a
measurable track record. What is dropped here is repetition, decided before it
was written rather than deleted after.

**In memory, per process**, like `unplaceableSymbols.ts`. A mid-session deploy
costs one extra row per symbol — ~31 against the ~7,700/day this removes. The
set is dropped whole when the ET day rolls, so memory is bounded by one day's
distinct pairs rather than by uptime.

**What this is NOT for.** Only STANDING facts — true for the whole day by
construction, so a later tick's row would be a copy. `candidate_found` (72,478)
and `signal_generated` (58,456) are genuinely per-tick observations that mean
something different each time they are written, and they stay.

### A test-suite consequence, recorded because it is the #46 class

Module-level state outlives a test *file*, and `DELETE FROM autotrade_events` in
a `beforeEach` does not touch it — the same invisible coupling as the shared
config row, one layer up. `test/setupProcessState.ts` now resets these caches
before **every test** (config isolation is per file; these are per test, because
a cache exists to suppress repeat work and any test wanting the first call's
behaviour must start empty). Add each new process-global cache to that file.

---

## 2026-09-09 — the stagnation exit learns whether the slot was scarce (task #41)

The 90-minute stagnation exit is the live book's **dominant exit** — 30 of 52
closes (58%) over 2026-08-24..09-04 — and it does what it says: it scratches.
Mean **−0.036R**, 14W/16L, **−$65.77** total.

Its stated justification is "recycling the slot for fresh signals". **That
applied in 7 of 31 firings.** The other 24 fired while the book was BELOW
`maxConcurrentPositions`, so nothing scarce was freed — the rule paid the spread
to close a trade at flat, and the next signal could have opened anyway. On the
two days the cap really was binding (09-02, 09-04) there were dozens of
`max_concurrent_positions` blocks inside the same half hour, so the rationale is
real there and only there.

### What shipped, and what deliberately did not

`stagnationExitRequiresScarcity` (**off by default**) narrows the rule to that
case. The DECISION is not in this change: the paper book has run without the
stagnation exit since 2026-09-08 and, since the end-of-day flatten landed
2026-09-05, without overnight carry either — so paper is now
same-signals-minus-the-90-minute-cut, exactly this counterfactual. Flip the flag
when ~2 weeks of paper closes are in, and exclude any close carrying
`pnlIsNotAMeasurement` when reading it.

### Scarcity is STATE, not history

"Scarce" is asked as *would a fresh full-size entry be refused for want of room
right now*, against the same two quantities the entry gate itself compares —
`combinedLiveOpenRisk()`'s count and risk:

| arm | test |
|---|---|
| concurrency | `openPositions >= maxConcurrentPositions` |
| risk budget | `openRiskUsd + nextTradeRiskUsd > (maxAggregateOpenRiskPct / 100) x equity` |

`nextTradeRiskUsd` is the **pre-cut** full-size figure (`riskPerTradePct / 100 x
equity`): the question is whether the budget has room for a trade at all, and a
step-down/regime/finish-line-cut trade is a smaller ask that would fit more
often. Both sides of that comparison are dollars, stated here because the
2026-08-27 bugs were unit mismatches inside honest-looking formulas.

Scanning the journal for recent `max_concurrent_positions` blocks was the
alternative and was rejected: it answers a question about the last few minutes
with a query shape nothing else depends on, and it would disagree with the entry
gate the moment either changed.

**Not modelled: buying power.** When BP is the binding constraint this reports
"not scarce" and holds the trade — the wrong direction for the rule's purpose,
since the slot really is blocking entries. Named in the source rather than left
to be discovered.

### The read is recorded whether or not the gate is on

Every stagnation decision now carries its `scarcity` verdict — on the scratch
(`live_time_exit_placed`, `trigger: "stagnation"`) and on the hold
(`stagnation_exit_held_slot_free`, once per position per ET day) alike. A
suppression-only record could not answer "was the cap binding when this fired",
which is half the question. That evidence accrues from now on, with the flag off.

When the flag is on and the book's room could not be measured this tick, the
position is **held**, not scratched: a gate that fires on an assumption is not a
gate.

---

## 2026-09-09 — the SIRI probe: two OTOCO groups DO coexist on one symbol

The 2026-09-08 FCX probe placed a **standalone** bracket (exits only, no MASTER)
over shares already held, and the broker compared it to held-minus-committed. It
could not answer the question per-lot brackets actually turn on, because its
refusal was fully explained by quantity and
`OPENAPI_ORDER_NOT_SUPPORT_REVERSE_OPTION` conflates the two causes.

Answered with **one share and six cents**, live, at 09:55 ET:

| | order | result |
|---|---|---|
| OTOCO #1 | BUY 1 SIRI @ 28.95, stop 28.26 / target 29.99 | **FILLED @ 28.80**, both exit legs resting → 1 held, 1 committed, available **0** |
| OTOCO #2 | BUY 1 SIRI @ 24.50 (15% below market, unfillable), stop 24.00 / target 25.50, **same symbol** | **ACCEPTED** — combo `C0JGQD5J959H6P10EU6AIK135B`, all three legs SUBMITTED |

Verified at the broker rather than from the acknowledgement:
`GET /api/autotrade/live/open-orders` showed **two SIRI combo groups resting
simultaneously**, the second carrying two SELL exit legs against a single share
already fully committed to the first.

**Two facts, both new:**

1. An OTOCO's **contingent** exit legs are **not** counted against holdings.
2. **Two OTOCO combo groups coexist on one symbol.**

**Consequence:** `lotsFitProtectiveBound` encodes the standalone rule and would
refuse the very plan the broker accepted. It must not gate the OTOCO entry path.
`planLotBrackets`, `classifySecondBracketRefusal` and `planRollbackToSingle` are
unaffected — though the *premise* of the refusal classifier changed and its
comment now says so, while its behaviour stays put.

**What the probe did NOT show, recorded because it bounds the claim.** OTOCO #2's
entry never filled, so its exits were contingent-pending throughout — never
ACTIVE protective orders over held shares. The steady state (both entries
filled, both groups' exits live, summing to exactly the held quantity) was not
observed. The arithmetic fits by construction, but so did the FCX bound before
it was measured, so **the wiring must submit both entries before either fills** —
the shape the probe validated — rather than adding a second group against an
already-filled first.

**Bonus, useful for the wiring:** cancelling an OTOCO's **MASTER** by client
order id **cascades** — the entire combo, both contingent legs included,
disappeared in one call.

**Method note.** The manual `/api/trade/place` path is governed by
`trading_config.maxExposureUsd`, which at $2,000 sits below the loop's own
routine book, so the probe was refused at 09:40 by a guardrail that had nothing
to do with the question. The operator authorised raising it to $5,500 for the
duration; it was restored to $2,000 immediately after and verified by read-back,
with every other guardrail untouched. Unwind: OTOCO #2 cancelled (cascaded),
OTOCO #1's take-profit cancelled first and its stop last, 1 share sold @ 28.74,
broker quantity 0, zero working orders, intent reconciled to `cancelled`.

### The wiring, and why it turned out small — `livePerLotBracketsEnabled`

The first estimate here was that one signal becomes **two positions**, breaking
six consumers that count a position as a trade. That was wrong, and the reason
is worth recording: **the merge already exists.**

```
autotrade_live_orders.addon_of_position_id
  -- scale-in add-on: the already-open position this order pyramids into.
  -- Its fill MERGES into that position (blended entry) rather than creating a new one.
```

`materializeAddOnFill()` sets the order's position id, blends the entry price,
sums the quantity and journals it — live code, on the scale-in path. Per-lot
brackets ride it, so the two lots become **one position** and concurrency, the
cooldown and every exit path still see one trade.

| | |
|---|---|
| **Lot 1** | the LARGER lot, entered normally with its own bracket at its own target |
| **Lot 2** | placed on a later tick as a bracketed ADD-ON, merging into the same position |

**Neither lot is ever unprotected, at any ordering** — each OTOCO is atomic,
entry plus its own exits. Simultaneity was never what protection needed; that
was the standalone bound's problem, not this design's.

**Which lot goes first is a P&L choice, not a safety one.** Between the two the
position is under-sized, and if lot 2 never fills it stays that way. The larger
lot therefore goes first, so the failure mode is "most of the intended size,
capped at the near target" rather than "a third of the size". A 50/50 tie breaks
toward the runner — an uncapped small trade beats a capped one.

**What actually changed, beyond the placement:**

- The **scale-out is turned off entirely** while this flag is on. They are two
  answers to one question, and running both would have the scale-out
  cancel-and-replace a bracket whose near target is already resting — reopening
  the very window per-lot brackets remove. Mutually exclusive in code, not by
  the operator remembering.
- `liveMaxOrdersPerDay` (20) is effectively **halved for entries**.
- The position row carries ONE `targetPrice` while the two groups have two. The
  runner's goes on the position, the partial's on the order row — a genuine
  modelling mismatch, named rather than hidden.
- The second lot's plan is journaled as `per_lot_entry_planned` and read back by
  the placer. **Journal-as-state**, deliberately: the plan must outlive the
  entry call and there is no column for it. A migration is the right home if
  this flag ever ships ON, and the event is wanted as evidence regardless —
  without it a position that never got its second lot is indistinguishable from
  one that was never meant to have one.

**Still off by default.** The probe proved two groups can be *submitted*; the
steady state — both groups' exits ACTIVE over one holding, summing to held — is
what the first live entry under this flag settles. Every outcome is journaled
(`per_lot_second_lot_placed` / `_blocked` / `_failed`) rather than only
returned, so that first entry can be read rather than reconstructed.

No bespoke settings control: `AllSettingsSection` renders every config field, and
the sibling flag `liveScaleOutEnabled` has no hand-written toggle either.

---

## 2026-09-10 — the enabling rules, counted by the app

**What shipped.** Rules 2–4 of the observer section's pre-committed enabling rules (and their
restatement under the size cut) are now computed by the server from what it already persists,
served as one object by `GET /api/market/regime-ml/readiness` and carried on the dashboard as
`mlRegimeReadiness`, and printed on the Auto page beside the overlay switch on both views —
the one place the operator would decide to flip it. Rule 3 gained a record: a daily check runs
the Python `regime:predict` with the server's own `asOf`, `previous` and `threshold` for each
counted session and POSTs the result to `/api/market/regime-ml/parity`; the server compares
(same data date, same label, probabilities within 1e-6), stores the verdict on the reading's
row beside the vector it compared, and journals `ml_regime_parity` once per day and verdict.

**The definitions, chosen once** (`server/src/services/mlRegimeReadiness.ts`, with the
model card's §5a "Readiness" saying the same):

- A session **counts** when its persisted reading is actionable — known and not stale, the
  sizer's own `actionableRegime` — came from the model rather than the dev override, and was
  read by the **current** model version. A retrain restarts the count; that is what rule 4's
  "re-run rule 1" already implies.
- **"Per week" is any 5 consecutive sessions.** A calendar week would pass two switches on a
  Friday and two more on the Monday; the field is named `maxIn5Sessions` so nobody reads it
  as a week. Switches come from the journal's `ml_regime_changed` rows, not the row's
  `switched` flag — the day's last classification overwrites the flag, the journal keeps the
  intraday flip. A weekend flip lands on the next session.
- **An inert streak, not a stale streak.** Rule 4's "5 stale sessions in a row" is read as five
  consecutive sessions the overlay had nothing to act on: a stale reading, an `unknown` one,
  or no row at all — the loop being down is inert too, and reverting to OFF is the
  conservative side. Today is skipped only while it has no row yet.
- **A parity verdict describes the reading it compared.** The loop overwrites a day's reading
  on every refresh (hourly until both series carry the prior close, and on `?force=true`), so
  agreement is re-derived on every read from the stored server vector against the row's
  current one; a reading refreshed after its check is unchecked again, and the readiness
  object lists exactly which sessions still need a check, with the inputs `regime:predict`
  must be given.
- **Drift and an overdue retrain block readiness.** Stricter than the rules' wording, on
  purpose: a model that no longer describes the tape is not one to switch a size cut on to.

**What this does NOT do.**

- It does not know whether the grid ran. Rule 1 is the decision-log row under "backtest parity
  for the overlay", filled by hand; `ready` means rules 2–4 hold and the object carries a
  literal saying so. The daily check reads the row itself.
- It flips nothing. A disagreement, a drift day or an inert streak is a finding on the page and
  in the journal; the switch stays where the operator left it.
- It adds no config field, so none of the three config guards changed. It never fetches: the
  route and the dashboard read rows only.

**Read on 2026-09-10.** The deployed box's first `ml_regime_read` was journaled on 2026-09-09
(`low_vol_bullish`, as of 2026-09-08, model `2026.09.1`), so the count started at 1 of 20; the
overlay sits at its defaults with live trading on.

---

## 2026-09-10 — a stop the sync had to price itself was booked as a human sale

`syncClosedWebullPositions()` closes a position the broker no longer holds, pricing the
exit from a live quote because it never saw the fill. Every one of those was booked
`exitReason: 'manual'`, on the reasoning that "everything reaching this point closed
outside the loop's own order flow". That is true of a human sale, and false of the one
case the sync's own deferral is built around: a resting BRACKET leg filled, the entry
order's reconcile did not catch up inside the grace window
(`MISS_CONFIRM_THRESHOLD` + `BRACKET_RECONCILE_GRACE_SYNCS`), and the sync closed it at
an estimate.

**SWKS, 2026-09-10.** 11 shares closed at a quoted 83.845 against a ratcheted stop of
83.85 — half a cent above — and journaled as `manual`. The money was right; the
attribution was not, and every exit-reason count the analytics draw (the excursion
replay's `reasons` mix, the "which mechanism makes the money" breakdown) silently
inherited the error. Note this is the same position whose deferral note already promised
the reconcile would book "whether it was the stop or the target": the sync knew it was a
bracket leg and threw the fact away.

`services/trading/bracketExitReason.ts` (pure) now answers which leg, from the levels the
bracket was resting at:

- at or through the stop → `stop`; at or through the target → `target`
- between the two, or within tolerance of both → `null`, and the caller keeps `manual`
- tolerance is 0.1% of the level for quote drift, capped at 10% of the stop-to-target
  span so one level's window can never reach the other on a tight bracket
- short positions mirror both directions

Two deliberate limits. The "a bracket leg filled" FACT is supplied by the caller from
`bracketPendingPositionIds`, never inferred — a human selling near the stop must not be
relabelled. And an expired option (priced at 0, no bracket explains it) is excluded. The
exit's note records that the reason was inferred rather than observed, and
`position_reconciled_from_broker` now carries `exitReasons` so the journal shows what the
close was actually booked as.


---

## 2026-09-11 — the replay learns the scale-out and the stagnation timer

**What prompted it.** The profitability review of 2026-09-10 read the deployed book:
on intraday bars the average favourable excursion is 0.52R and the realized average
0.01R; of 59 same-session trades the 2R target was reached once, 25 ended on the
clock and 18 at breakeven. The first lever it named was to bank the book's half-R
peaks and free stagnant slots sooner. The tool for scoring that — the exit-rule path
replay of 2026-09-09 — could not see either lever: it walked the stop, breakeven, trail
and target and nothing else, while the live book has banked `partialExitPct` at
`partialExitRMultiple` since 2026-09-08 (67% at 0.25R in production) and scratches a
trade held `stagnationExitMinutes` below `stagnationExitMinR`. Its "current rules" arm
was not the current policy.

**What shipped.** `ExitRules` gained four optional fields — `scaleOutR`,
`scaleOutFraction`, `stagnationMinutes`, `stagnationMinR` — replayed in the same
adverse-first order as everything else in `services/exitReplay.ts`: a bar holding both
the stop and the scale-out level fills the stop; the scale-out fills before the target
(its level sits below it) and the target then takes only the remainder; the timer is
read at a bar's close, the bar's tick. A result's `exitR` is the position-weighted blend
of the banked share and the remainder's exit, `reason` is how the remainder ended (now
including `stagnation`), and `scaledOut` / `bankedR` say what the scale-out contributed.
Absent, the fields replay byte-for-byte as before, so the exit-tune validation and the
short-shadow record — which isolate geometry on purpose — are unchanged.

`GET /api/journal/exit-replay` now defaults the two rules from the live config (the
scale-out only while `liveScaleOutEnabled` is on), and takes a candidate shape as
`c`-prefixed overrides of the same rules (`cScaleOutR`, `cScaleOutPct`,
`cStagnationMinutes`, `cStagnationMinR`, and the four multiples). The response's
`comparison` replays both arms over the same trades — paired, or not at all — with each
arm's mean R, its exit reasons and its scale-out count, the paired difference, its
sign-flip 95% interval, and a verdict. The verdict rule (`replayVerdict`) is one function
the exit-tune validation now calls too, so the two readers of a paired replay cannot
disagree about what "better" means.

**The pre-committed reading, written before the first run.** A candidate shape is
adopted only on `better` (the paired interval above zero on at least 20 paired
same-session trades); `worse` rules it out; `inside_noise` keeps the current settings
and asks again after another 20 trades. The config fields it would move are
`partialExitRMultiple`, `partialExitPct` and `stagnationExitMinutes`, by the operator,
recorded here in a dated row.

**What this does NOT do.** It models no slippage and no fill mechanics — a live scale-out
reduces the bracket legs before it sells, and can be abandoned for a tick — and it
ignores the scarcity gate on the stagnation exit (`stagnationExitRequiresScarcity`, off
in production). It replays same-session trades only, so bar-time minutes are session
minutes. It changes no config and no live path: the replay is a reader.

| date | candidate | current mean R | candidate mean R | paired diff (95% CI) | trades | verdict | action |
| ---- | --------- | -------------- | ---------------- | -------------------- | ------ | ------- | ------ |
| 2026-09-11 | bank 50% at 0.5R (`cScaleOutR=0.5&cScaleOutPct=50`) | 0.08 | 0.07 | −0.01 (−0.04 to +0.02), p 0.55 | 60 | inside_noise | kept 0.25R / 67%: 16 of the 60 trades reach 0.5R, against 39 that reach 0.25R |
| 2026-09-11 | scratch at 60 min (`cStagnationMinutes=60`) | 0.08 | 0.07 | −0.01 (−0.03 to +0.01), p 0.53 | 60 | inside_noise | kept 90 min: 26 stagnation exits against 16, at the same R |
| 2026-09-11 | neither (`cScaleOutR=0&cStagnationMinutes=0`) | 0.08 | 0.06 | −0.02 (−0.07 to +0.04), p 0.47 | 60 | inside_noise | kept both |
| 2026-09-11 | isolation, no scale-out (`cScaleOutR=0`) | 0.08 | 0.06 | −0.02 (−0.07 to +0.04), p 0.48 | 60 | inside_noise | the scale-out's own share of the current shape |
| 2026-09-11 | isolation, no timer (`cStagnationMinutes=0`) | 0.08 | 0.08 | 0.00 (0.00 to +0.01), p 1.00 | 60 | inside_noise | the timer costs nothing in R; what it buys, the slot some three hours earlier, a per-trade replay cannot price |

**The first reading, 2026-09-11.** The deployed book: 131 closed stock trades, of which
25 undated, 32 not same-session and 14 unreplayable, leaving 60 paired same-session
trades entered 2026-07-15 to 2026-09-10; the current shape is breakeven at 0.25R, a
0.5R trail from 0.5R, target 2R, bank 67% at 0.25R, scratch at 90 minutes below 0.5R.
Every shape lands inside the noise, so by the rule above nothing moves:
`partialExitRMultiple` stays 0.25, `partialExitPct` 67, `stagnationExitMinutes` 90, and
the question is asked again once the paired count reaches 80.

Two things the run says beyond its verdicts. The book's peaks are shallow: of the 60
trades, 39 reach 0.25R, 16 reach 0.5R, 5 reach 1R and 1 reaches 2R, which is why banking
later banks less often and nets nothing, and why the timer's 16 scratches replay at the
same R the clock would have given them. And the current shape replays at 0.08R against
a realized 0.01R over the same 60 trades, a gap larger than any shape's effect. It is
not a pure execution gap: 40 of the 60 were entered before the live scale-out shipped on
2026-09-08, under whatever multiples the tuner held at the time, so the realized figure
mixes past policies with fills. However it splits, the lever is not in the exit shape.

---

## 2026-09-12 — the exits are made to fill

**What prompted it.** The operator's decision of 2026-09-12: strive for the 3% daily
goal now, accepting more risk, with the safety nets loosened rather than removed. Before
any setting moves, the exits have to work at the size the settings will produce — and a
day of reading the live journals found three places where they did not. Two of them cost
money on 2026-09-11 alone.

**HOOD 260911C116, one contract at $0.90, 10:16 ET.** The short-dated ladder decided
correctly three times and the account still lost the trade:

| time | rule | what the close did |
| --- | --- | --- |
| 10:18 | `take_profit` at +64% | DAY limit at 1.40, five percent under a 1.47 mark — never filled |
| 11:15 | `give_back` at −43% | second limit at 0.45 — never filled |
| 14:00 | `hard_time` at −97% | refused: `roundOptionPrice(0.03 × 0.95) = 0`, "below the $0.05 option tick", every tick to 17:05 |
| 16:00 | — | expired worthless; the row stayed open all evening |

+$58 two minutes after entry became −$90. Three separate mechanisms, one outcome.

**1. The price was never where the contract could be sold.** The chain this path prices
from is Yahoo-sourced and ~15 minutes delayed, and it was collapsed to a midpoint before
the 5% sell buffer — an average of a price nobody is offering and one nobody is bidding,
as of a quarter of an hour ago. Webull's own `/option/snapshot` returns real-time OPRA
bid/ask and nothing on the autotrade path read it. Closes are now priced at the OPRA bid
when it is present and under two minutes old, then the chain's bid, then the buffered
mark, with the basis in the journal. The intent's reference price follows the basis, or
the fat-finger guardrail would block a real-time bid judged against a stale midpoint. A
bid further under the mark than `liveOptionsFatFingerPct` is treated as corrupt and
ignored. The exit ladder still evaluates on the mark: its rule levels are defined there.

**2. Nothing re-examined a working close unless a clock rule fired.** That gap is
structural, not a missed case: between the take-profit level and the give-back arm level
no ladder rule fires, and that band is exactly where a working close lives. A close is
now chased every tick — left alone at or below the bid (NKE's +$6 recovery on 2026-09-10
is why that half is unchanged), cancelled and re-placed above it, carrying the original
decision's exit reason read off the order row rather than re-derived. Four guards: a
post-cancel broker status read for the fill race, a mid-fill deferral, 20 re-prices per
position per ET day, and no cancel at all under the kill switch.

**3. A sub-tick mark refused the close outright.** A sell rounds DOWN, so anything under
half a tick became zero and was rejected. A price that rounds off the grid is now floored
at one tick; only a mark of exactly zero, no quote, or a crossed spread still refuses,
and the expiry sweep owns those. The failure journal is throttled to once per position
per cause per ET day with a push on the first claim — 122 identical rows in one afternoon
buried the one that mattered, and `liveFailureAlert` counts rows.

**4. An expired 0DTE sat open all evening.** The sweep took expirations strictly before
today. The window is now "before today, or today once its own session has closed", with
no walk-back to a prior day's close for a same-day contract (that is a different day's
price) and a quiet wait when the settlement bar has not published. Rule A1 in
`docs/OPTIONS_TUNING_PLAN.md` can no longer read as open overnight.

**5. A naked equity position was paged, not fixed.** `checkLiveBracketProtection` has
been able to prove a position naked since the held-quantity read went in — shares
confirmed at the broker, zero resting stop — and its whole response was a journal row
saying to re-arm by hand. GRMN sat that way on 2026-08-25. It now places a standalone
protective bracket automatically from the position's own stop and target, and pages only
when that fails, with the reason. Never on an unreadable account (bracketing an unknown
holding is how a covered position becomes a short) and never after an unanswered
placement (two stops against one position).

### What this does NOT change

No entry gate, no sizing, no ladder rule level, and no config field. The paper options
path is untouched. The stop-leg matcher in the ratchet path is deliberately left as it
is: DELL journaled "no resting leg identifiable as STOP_LOSS among 2 exit order(s)" 62
times on 2026-09-02 and the stop never moved that day, but it already tries two
independent markers and the obvious third — assume the leg below the market is the stop —
is a guess on a safety-critical match where being wrong means moving or cancelling the
target. A missed ratchet is opportunity cost; the wrong leg is real money.

### The pre-committed check

The first options exit after deploy journals `live_options_exit_placed` with
`priceBasis: 'bid'`. The first close that outlives its price journals
`live_options_stale_exit_cancelled` with `trigger: 'chase'` and a null `clockRule`,
followed by a `live_options_exit_placed` carrying `replacedIntentId` and
`repriceCount: 1`. If neither appears within five sessions with options trading on, the
change is not doing what this section claims, and that is worth finding out before any
further exit work.

## 2026-09-12 — the dollar caps are made to follow the account

Decision 10 of the 3%-goal plan asks that everything scale with the account. Three
things did not, and all three are in the stored **dollar** caps — the only settings that
are literal dollars rather than percentages of live equity.

**1. The options per-order cap was a share-sized number.** `deriveDollarCaps` assigned
`liveMaxOrderUsd` verbatim to `liveOptionsMaxOrderUsd`: a band fraction of equity, sized
for a stock position, guarding an options order whose whole notional is premium. On
2026-09-06 that read **$4,269 against a $92.72 largest legitimate order** — 46× — so it
was set by hand to $300, and a hand-set cap is (correctly) skipped by every automatic
re-anchor. It has been frozen ever since, with its revisit trigger written into
`docs/OPTIONS_TUNING_PLAN.md` because nothing would move it.

It now comes from the options sizer itself. `optionsRiskCheck` sizes a single leg so
that `contracts × premium × 100 ≤ equity × riskPct ÷ f` (f = `optionsDisasterStopPct`
as a fraction) — the right-hand side is the largest notional the sizer can produce at
**any** premium, because a cheaper contract simply buys more of them.
`maxAffordablePremiumPerShare()` is the per-share inversion of that same rule and is
pinned against real `computeRiskSizing` output in its own suite, so the cap agrees with
the sizer **by construction** rather than by a second copy of the arithmetic. Times the
100-share multiplier and the existing 1.5 headroom, `ceil()`-ed so rounding can never
put the cap below the sizer's own maximum.

Two deliberate departures, both recorded because they are the kind of thing a later
reader would otherwise take for a slip:

- The plan's formula multiplied by `optionsMaxConcurrentPositions` (≈$550 at two
  slots). **Dropped.** `maxOrderUsd` is enforced per ORDER — `order_notional` in
  `services/trading/guardrails.ts` — so a slot count belongs in an aggregate cap.
  Multiplying by slots would leave one order able to carry twice what the sizer can
  produce: a weaker fat-finger backstop, not a safer one.
- The ceiling uses `riskPctUpperBound` (risk × `expectancyMaxMultiplier` when method
  weighting is on), not the bare risk %. `effectiveRisk`'s `method` factor is allowed to
  scale UP, and a cap derived from the unmultiplied figure would refuse an order the
  sizer had just produced — the 2026-08-27 "a correct order could never fit its own cap"
  shape.

A zero risk budget derives no options ceiling at all; rather than store a 0 that blocks
every order, it falls back to the equity backstop. A misconfiguration degrades to "too
loose", never to "cannot trade".

**2. The re-anchor threshold was 15%, so the caps lagged equity by weeks.** The account
ran $5.1k → $3.5k → back without a single re-anchor. `REANCHOR_THRESHOLD_PCT` is now
**5** — still an order of magnitude above per-tick mark-to-market noise on this book,
and the anchor still moves on every re-anchor, so it cannot churn.

**3. A bad reading re-anchored the caps DOWN.** On 2026-09-11 the account was traded by
hand: equity read $5,129 in the morning and $3,523 in the afternoon, and every cap was
cut ~30% while the strategy's own book had not lost a cent. The tick-to-tick equity
guard cannot see this — closing a position by hand walks equity down in individually
in-band steps — so the comparison has to be against the **anchor**. A reading more than
`SUSPECT_DROP_PCT` (25%) below the anchor now holds every cap where it is for that
session and journals `equity_read_suspect` once, and re-anchors normally as soon as the
same low reading survives into the next session. A real decline persists; one
afternoon's hand trading does not.

Three things bound that hold, and each is deliberate:

- **Downward only.** An upward move re-anchors on sight, as it always did, and an upward
  JUMP still has to survive the sync guard's three corroborating ticks to be written.
- **A blocking per-order cap wins.** A cap under the sizer's floor means nothing can be
  placed at all; one session of that is worse than one session of pessimistically small
  caps.
- **Its own constant, not `equitySyncMaxJumpPct`.** That field governs a different
  comparison — this reading against the last one — and loosening it to accept a deposit
  must not silently loosen this. Numerically the same 25 today, on purpose.

The hold costs at most one session of stale dollar backstops. Every percent-of-equity
rule — the drawdown halt, the aggregate risk cap, per-trade risk, the premium ceiling —
is applied to live equity at decision time and is unaffected.

**4. A frozen cap is now visible.** The dashboard carries `capsCoherence`: each stored
cap, the value the current config derives at the anchor equity, and whether the cap is
still anchor-owned. The Auto page's **Live guardrail caps** panel shows the pair and
tags a frozen one. Setting a frozen cap back to its derived value hands it to the
re-anchor again — already the rule, and now something a reader can act on. The
"hand-edited" verdict comes from `handEditedDollarCaps`, the same function the
re-anchor consults, rather than a second reading of the same question.

**Pre-committed check.** After this deploys, `GET /api/autotrade/dashboard` must show
`liveOptionsMaxOrderUsd` with a `derived` value in the low hundreds (not thousands) and
`anchorOwned: false` until Step 2's config write sets the stored value to the derived
one — at which point it must flip to `anchorOwned: true` and stay there through the next
`live_caps_reanchored`. If the options cap is still reported frozen after that write,
the derivation and the write disagree and one of them is wrong.

## 2026-09-12 — the app looks for its own leaks

Three leaks were found in this book in one week. Every one of them was found because a
human happened to look, and every one of them was already sitting in a journal the app
was writing:

- second entries on a stock that had already run gave back what the first entries made
  (live round 1 n=64 **+$342**, round 2 n=20 **−$185**; the paper book agrees) — the
  operator remembered it;
- the options sleeve decided its exits correctly and never filled them — found by
  reading one position's tick timeline by hand;
- the options per-order cap was 14× too large, hand-frozen, and describing an account
  that had since moved — found while writing a plan.

"Why are these only found when I tell you about them" is a fair question with a
structural answer: nothing walked the book looking for them. The scan does.

**What it is.** `services/autotrading/edgeLeakScan.ts` (pure) plus
`edgeLeakScanData.ts` (the DB half) and `GET /api/journal/edge-leaks?sessions=40&book=
live|paper|both`. It cuts both books by a fixed catalog of dimensions, applies one
statistical bar to every bucket, and reports what fails it with the lever that closes it.
Database and journal only — no market data, no provider quota — so the daily routine can
run it every evening.

**One bar, every dimension.** A bucket is a **leak** at n ≥ 15 when its whole 95%
bootstrap interval sits below zero AND the paper control (n ≥ 10) agrees in sign;
**unconfirmed** when the control cannot speak to it; a **watch** at n ≥ 10 within 0.05R
of the bar. Nothing else is reported. The control arm is the load-bearing part: both
books consume the same `decision.signals` in the same tick (paper first, `loop.ts`), so a
bucket that loses in both is a property of the DECISION and a config lever closes it,
while one that loses only live is a property of EXECUTION and code closes it. Those are
different findings, and the scan refuses to hand the decision's lever to an execution
problem.

Deliberately 15 rather than `significance.ts`'s own `MIN_RELIABLE_TRADES` of 20: this is
a screen that says "go look", not a conclusion, and the control plus the interval carry
the weight the sample size does not.

**What the catalog cuts by (v1).** Round within symbol-day · entry half-hour · the
after-13:00 aggregate · score band · VWAP extension · % of session range · exit reason ·
hold time · symbol (n ≥ 5) · sector · weekday · ML regime · asset · position size.
Alongside them: the **day level** (goal reached on N of M active sessions counted through
the sweep's own `simulateSession`, the same count at 1R, red-day decomposition by exit
reason, mean and worst red day), the **attribution** (each paper entry paired to a live
entry on the same symbol and ET date within 60 s → mean per-trade R difference and entry
slippage; unpaired paper entries classified by the live journal's own skip action), and
**findings** — execution occurrences over the last 10 sessions and configuration
mismatches, where one occurrence is enough.

**A trade with no value for a cut is EXCLUDED and counted, never pooled into
"unknown".** An unknown bucket mixes unrelated trades and then reports a mean for them,
which is how a measurement becomes a fiction. Every dimension reports `covered` and
`uncovered` so a thin cut is visible as thin.

**Determinism matters more than it looks.** The bootstrap is seeded from a constant, so
the same book produces the same intervals on every run. A leak that appears and
disappears between two reads of identical data is worse than no scan at all.

**The rule that keeps the catalog honest**, written into the playbook: when a human finds
a leak the scan missed, the dimension that would have caught it goes into `DIMENSIONS` in
the same PR that fixes the leak. Otherwise the next miss is silent for exactly the reason
this one was.

**Pre-committed first reading.** On the book as it stands the scan must report round 2 as
a leak (both books negative, lever `symbolReentryCooldownMinutes` → 390), the HOOD
options day as an execution finding, the options order cap as a configuration finding
(hand-frozen), and the entry-extension buckets as watches at most. **If it does not, the
scan is wrong, not the record.** That sentence is the check: it is written before the
first production read, so the scan cannot be quietly adjusted until it agrees with
whatever it happens to say.

**The goal-rate line.** `DailyGoalEvidence` gains `storedTargetR`,
`goalReachedSessions`, `activeSessionsCounted` and `goalRatePct`, and the Auto page shows
"the goal is 1.20R; reached on 4 of 16 active sessions (25%)" beside the expected-day
identity. The two answer different questions and the rate is the one a sizing change
moves first: the goal's height in R is `targetPct ÷ riskPct`, so raising the risk % lowers
the bar without the book changing at all. It counts sessions that REACHED the goal, not
sessions that closed above it — `SessionOutcome.reached` was computed by `simulateSession`
since the sweep was written and returned by nothing, which is the same
value-computed-and-never-consumed shape CLAUDE.md's own scars are made of. Under `bank`
the day halts new entries at the level while open trades run on, so a session can reach
the goal and still close below it; `dayR >= levelR` would have quietly undercounted.

**Where it is read.** The dashboard carries `edgeLeakSummary` from the LAST persisted
scan (one row, `edge_leak_scans`) rather than running one per poll — a per-bucket
bootstrap over both books is real CPU and the dashboard is polled. The Auto page's line
is silent on a clean scan: "0 leaks" every day trains the eye to skip it.

## 2026-09-12 — the day's result is kept

The day's percentage lived in exactly two places, and neither one remembered it: the
singleton `autotrade_daily_baseline` row, overwritten at the next morning's first tick,
and the dashboard's live `dailyTarget.gainPct`, recomputed per poll. "How did last
Tuesday go" had no answer anywhere in the app.

`autotrade_daily_results` is one row per trading session, written by the loop on every
tick after the session close (reusing `isAfterSessionClose` from PR A) and surfaced as a
month calendar at `/results`, with a six-week strip under the Auto page's goal card.

**Two percentages, never one.** The **account** figure — close equity over opening
equity — is what the operator feels, and it carries deposits, withdrawals and anything
traded by hand. The **strategy** figure is the realized P&L of positions the loop itself
opened and closed that day, over the same opening equity. Reporting only one of them
would be wrong in one direction or the other on every day they diverge, so the row keeps
both and FLAGS the days they disagree by more than `MANUAL_TRADING_DIVERGENCE_PCT`
(0.5% of equity). 2026-09-11 is the canonical case: the account fell ~31% across an
afternoon of hand trading while the strategy's own book had not lost a cent — and the
same reading re-anchored every dollar cap, which is the other half of today's work.

Both percentages are over the SAME baseline, so their difference is itself a percentage
of equity and compares against the threshold directly. Two quantities in one comparison,
and they are in the same unit by construction rather than by luck (CLAUDE.md).

**What is never invented.** A session that predates the baseline row has no opening
equity recorded anywhere. The backfill fills the strategy columns — exact, because the
positions ledger goes back further — and leaves the account columns NULL, and the
calendar says so on those cells rather than showing a number derived from a guess.
`manualTrading` is false, not true, for such a day: with nothing to compare, a flag
would be a claim.

**It re-records rather than writing once.** An exit can still reconcile after the close
and the equity sync keeps running, so a row frozen at the first post-close tick would
miss both. The upsert REPLACES, which is also what makes `POST
/api/journal/daily-results/record?date=` a usable correction. A recording for a PAST
date takes its account columns from the row already stored rather than from the baseline
singleton, which by then belongs to a different day.

**Aggregates sum dollars and average percentages.** A sum of daily percentages is wrong
twice over — it is not how compounding works, and it counts deposits — so the weekly and
monthly rows sum `strategy_pnl_usd` and take the MEAN of the percentages, over the days
that have one.

**The calendar's design** (dataviz): a diverging scale, two hues either side of a neutral
midpoint, equal steps per arm. The hues are the app's own `bull`/`bear` rather than the
generic blue↔red, because in this domain green and red already mean gain and loss on
every other surface. Three steps per arm as alpha over the card surface, so one set of
steps works in both themes. The fills sit in the recessive band on purpose — the relief
rule allows that exactly when the value is readable another way, and every tile carries
its number in a text token (the strongest fill still clears 5:1 against the label in
dark, 8:1 in light). **The sign is never carried by color alone**: every tile prints an
explicit `+`/`−`, badges are letters (G/B/H/M) rather than colored dots, and the table
below the calendar is the accessible twin of the heatmap.

**The scale is dynamic**, which is Decision 10 applied to the UI: magnitude is measured
against the stored daily GOAL, not a hardcoded percentage, so the calendar re-scales
itself the moment the goal or the risk % changes. A day that reaches the goal is always a
full-strength tile, whatever the goal happens to be.

## 2026-09-12 (post-deploy) — the first scan reading, and the pre-commitment that failed

The 3%-goal plan's sizing change went in and the edge-leak scan ran for the first time on
the deployed book. Both are recorded here because one of them contradicts this plan's own
written prediction, and a pre-commitment that is quietly dropped when it is inconvenient is
worse than none.

**What was applied.** Risk 1.25 → 2.5%, exposure 190, aggregate 7.5, halt 7.5, expectancy
max 1.25, scale-out off, target 1R, stagnation 60, re-entry cooldown 390, auto-tuner off,
the regime overlay on at cut 50 / tighten 15; then the options sleeve to 2 slots, 6 orders a
day, and a per-order cap of $236 (the derived value). The goal itself did not move.

**The new machinery proved itself within a minute.** Raising the risk % put `liveMaxOrderUsd`
($2,744) below the sizer's own floor (100% of equity at 2.5/2.5). The blocking rule plus the
new 5% threshold re-anchored at 03:56:37Z on a **3.7% drift** — a move the old 15% rule would
have ignored, leaving a cap that blocks every entry. It rewrote the cap to $5,284. All four
dollar caps then read `anchorOwned: true` for the first time since 2026-09-06.

**The goal-rate line landed on the plan's estimate**: the goal is **1.20R**, reached on
**4 of 16** active sessions (**25%**) — the "roughly one active session in four" the sweep
projected, now measured rather than assumed.

### The pre-committed reading did not hold

The scan was shipped with this written down: *"on today's data the scan must report round 2
as a leak (both books negative, lever `symbolReentryCooldownMinutes` → 390) … If it does not,
the scan is wrong, not the record."*

It reported **zero leaks**. On the evidence the record moved, and the scan is right:

| round | live | paper (control) |
| --- | --- | --- |
| 1 | n=73, +0.01R, +$107 | n=77, +0.05R |
| **2** | **n=23, −0.24R, −$132.08**, CI **[−0.65, +0.10]** | **n=25, +0.04R** |
| 3+ | n=6, +0.07R, +$14 | n=26, +0.06R |

Two of the bar's three tests fail. The live interval straddles zero, and — the one that
matters — **the paper control disagrees in sign**. The plan's hand analysis had paper round 2
at −0.01R over 12 trades; that sample has since doubled to 25 and come out slightly positive.
Under the scan's own logic, "loses live, does not lose in paper" is an **execution** pattern,
not a decision one, and the scan correctly refuses to hand it the decision's lever.

The cooldown stays at 390 by the operator's decision, recorded in
`docs/TUNE_FROM_TARGET.md`'s goal log as a **judgment call rather than a demonstrated leak**,
to be re-read at the 10-session review. The important part is the shape of what happened: the
pre-commitment did its job. It was written before the first read precisely so the scan could
not be tuned until it agreed with the prose, and when the two disagreed the prose lost.

### Two other readings worth keeping

- **The 13:00 question is settled, negatively.** Live after-13:00 is +0.06R (n=28); paper is
  −0.33R (n=17). The books point opposite ways, so the playbook's written rule — build the
  equity entry cutoff only when the live bucket clears the bar AND paper agrees in sign —
  says do not build it. That is the rule refusing a change, which is the harder half of
  having one.
- **The options sleeve's gap, in numbers.** Live options −0.71R over 3 trades (−$171);
  paper options +0.23R over 20. Live-only again, which is exactly the execution gap PR A
  addresses. No live options trade has yet run under the fixed code, so the first one is the
  real test — not the sleeve's widening.

The only watch is Mondays (n=10, −0.21R, CI [−0.46, +0.01]). Execution findings are dominated
by pre-fix history: `live_options_exit_failed` ×261 is the 2026-09-11 HOOD day firing on every
tick before the throttle shipped, and `live_scale_out_blocked` ×147 is a mechanism now
switched off.

### The tuner finding needed a moment to measure from

The scan's first run also reported "the tuner wrote while it was meant to be off ×14" — all
fourteen from the week **before** the tuner was switched off, and all of them legitimate. The
check asked a question it had no baseline for, and would have repeated the same false finding
on each of the next five routine runs.

The config row cannot supply that baseline: its `updated_at` moves on every loop tick, because
the equity sync writes `accountEquityUsd` every minute. So the moment is journaled explicitly
— `auto_tune_disabled` / `auto_tune_enabled` on the flag's transition — and the finding counts
only rows newer than the switch. When the journal does not say (a flag that flipped before
that row existed, which is this very day), it falls back to **today only**: the narrowest
window that still has teeth, since the tuner runs once per ET day at 00:00 and a real
violation therefore surfaces on the next day's scan rather than never. The two transition
actions are excluded from the count, or switching the tuner off would report itself.

## 2026-09-12 — the criteria apply themselves, after they have shadowed

Every gated item in the 3%-goal plan has a written criterion, and until now the criteria
were checked by a human reading a daily routine's output. That is a single point of
failure sitting underneath a risk increase: the routine has to fire, and someone has to
read it correctly, on each of the ten sessions the pre-committed review runs over. The
gated-switch engine (`services/autotrading/gatedSwitches.ts`) evaluates them itself, on
the first loop tick after each session's close.

**The operator's division, encoded.** A rule that REDUCES exposure — a revert, a size
cut, a cooldown, a score floor — may be applied by the app. A rule that ADDS exposure is
reported and waits for the operator, always, with no graduation path at all. That
asymmetry is the whole safety model, so `direction` is a required field on every rule and
`exposure` is checked in three separate places rather than one.

**Every safe rule shadows before it acts.** This codebase's own convention is to ship a
mechanism as a measurement first — the entry-extension gate, the short shadow record and
the regime-tighten ledger all did — and a mechanism whose output is a config write on
live money has a stronger claim to that than any of them. So a rule starts in SHADOW: it
evaluates, journals what it WOULD have applied (`config_change_proposed`, with the
blockers that stopped it), and changes nothing.

The shadow costs nothing that is not already being paid. During it the routine reports
each proposal exactly as it does today, so a genuine revert is still one line away from
being applied by hand.

**A rule graduates by its own written criterion**, checked by the engine — nobody has to
come back and flip a flag:

- it reduces exposure, **and**
- it has been EVALUATED on at least `SHADOW_MIN_EVALUATIONS` (5) sessions, **and**
- it has actually FIRED at least once — a rule that has never proposed has demonstrated
  nothing, however long it has sat there, **and**
- it has never CONTRADICTED itself: proposed, then read not-met on the very next
  evaluation without its patch having been applied in between. A rule that flaps is a
  rule reading noise.

The state is read BEFORE the session is folded in, so a rule that meets the bar and is
met today graduates and applies *today* rather than a session later.

The contradiction test has one subtlety worth stating: when the patch WAS applied, the
criterion ceasing to hold is the patch **working** — the opposite of a contradiction —
which is why "was it applied" is a parameter rather than something inferred from the
sequence.

**What stops a write, and what does not.** The master `gatedSwitchesEnabled` flag and the
kill switch suppress APPLICATION only, never evaluation: a shadow record that froze while
the engine was off would hand a rule a graduation it never lived through the moment it
came back on. A rule already evaluated on today's ET date is skipped, so a restart loop
cannot graduate anything in an afternoon. And the shadow record is a TABLE
(`gated_switch_state`), not memory, for the same reason.

**The blast radius is explicit.** `SWITCH_WRITABLE_KEYS` lists every field a rule may
write, and `assertWritable` enforces it at runtime as well as in the type — because a
patch assembled from a leak scan's `lever` is *data read out of a scan result*, not
literal code, so "the rule only writes what its source says" is not something the type
system can promise. A rule that wanted a new field has to come to that list and justify
it.

### The rules, v1

| rule | direction | criterion |
| --- | --- | --- |
| `overlay_revert` | safe | the overlay is on AND any of: a parity disagreement, a drift day, an inert streak of 5, more than 2 regime switches in any 5 sessions |
| `sizing_revert` | safe | at 10+ active sessions since the sizing change: the mean day is negative, OR the drawdown halt tripped twice in any 5 sessions |
| `leak_lever` | safe | the last edge-leak scan reports a LEAK (not a watch, not unconfirmed) whose lever is a config field in the safe direction |
| `frozen_cap` | safe | a stored dollar cap no longer equals its anchor-derived value, so every automatic re-anchor skips it |
| `shorts` | exposure | 30 shadow short trades, average R ≥ +0.1, win rate ≥ 50% — reported, never applied (reads the persisted short shadow record since 2026-09-19) |

Three of them refuse to fire when the change would be a no-op — `sizing_revert` when the
risk % is already pre-trial, `leak_lever` when the config already carries the lever's
value, `frozen_cap` when every cap is anchor-owned — because a rule that proposes the
same thing every session forever is a rule nobody reads.

**Not implemented, and why:** the plan's shock-nowcast rule (`regimeShockRangeRatio` once
the nowcast has anticipated the model's High-Vol reads on a majority of ≥3 shock days).
Its evidence is not computable from what is journaled today, and a rule that guesses at
its own criterion is worse than one that says it cannot read it yet. `shorts` was in the
table evaluating to null "for the same reason — its three numbers are not in one place";
that claim was wrong, and the dated section of 2026-09-19 says how (the numbers were in
one place, the short-shadow route, and nothing read it). It reads the persisted record now.

### Two dates that had to be journaled

Both the review rule and the tuner finding need to know WHEN a setting changed, and the
config row cannot say: its `updated_at` moves on every loop tick, because the equity sync
writes `accountEquityUsd` every minute. So the config route journals the transitions —
`sizing_changed` when `riskPerTradePct` moves, `auto_tune_disabled` / `auto_tune_enabled`
when the tuner's flag flips — beside the handful of flag transitions it already recorded.
(Since 2026-09-19 it also journals every other field a PUT moves, as one `config_changed`
row per request — see the dated section of that day. The two rows named here are still
written, and `sizingChangedOn` still reads `sizing_changed`.)

Where the journal cannot say (a change that predates the row, which the 2026-09-12 trial
itself is), the review window falls back to the sessions the loop actually RECORDED,
identified by their having an account baseline. A backfilled historical row has null
account columns by construction, so the fallback cannot over-count the window with
sessions from before the change — and over-counting is the only direction that would let
the rule fire early.

**Pre-committed check.** After this deploys, every rule must appear on the Auto page's
"Automatic switches" card with `0/5` progress and nothing graduated, and the first
post-close tick must journal `config_change_proposed` for `frozen_cap` — the options cap
was hand-set to its derived value on 2026-09-12, so if any cap reads frozen again the
re-anchor and the derivation have diverged. No `config_auto_applied` row may appear
before a rule has five evaluations behind it; if one does, the graduation gate is not
doing its job and the engine should be switched off at `gatedSwitchesEnabled` while it is
worked out.

## 2026-09-12 — the tune advisor: what to change next, and how much it is worth

The app collects a great deal and synthesises none of it. The goal evidence says what a
normal day is worth, the sweep says what goal is reachable, the edge-leak scan says where
money is lost, the attribution says what the live book refuses — and a reader has to hold
all four in their head to answer "so what should I change". `services/autotrading/
tuneAdvisor.ts` answers it, ranked.

**Everything here is one equation, differentiated.** The app's own identity is

    expected day % = trades/session × risk% × avg R

so there are exactly three factors to move, plus the execution drag that stops a decided
trade from becoming the R it was worth. Every recommendation names which factor it moves
and estimates its effect in **percentage points of the expected day** through that same
identity. That is what makes them rankable against each other rather than a list of good
ideas.

Two arithmetic choices worth stating, because both are easy to get wrong in the
flattering direction:

- **A leak is spread over the WHOLE book, not its own bucket.** Closing a bucket that
  loses 5R lifts avg R by 5R ÷ *all* live trades, not by that bucket's own −0.24R mean.
  The second number is five times larger and answers a question nobody asked.
- **An execution defect gets no estimate at all.** An exit that failed cost whatever that
  trade would have made, which a count cannot tell you. A fabricated number would let a
  defect be ranked against a distribution as though the two were measured the same way.
  They are ranked above it instead, by construction: a broken stop is not a distribution.

**A recommendation is not only a setting.** Where the data implies something with no
config field — an entry cutoff that does not exist yet, an exit path that decides
correctly and fills badly — the action comes back as `kind: 'code'` with what to build,
and where the honest next step is a measurement rather than a change, as `'research'`.
"Tune" means the workflow, not just the knobs.

**And it is not permission.** Decision 7 pre-commits to one change set with no mid-course
knob turning except the revert, precisely because a daily recommender invites the
opposite. So anything that would widen the trial's own settings before the 10-session
review is `blocked_by_review`, with the session count that will unblock it. A leak's lever
is NOT held that way: the review guards against widening mid-trial, not against plugging a
hole.

**The headline can say the change will not get you there**, and usually will. On a book
whose implied day is 0.5% against a 3% goal, the sum of everything measurable is a
fraction of the gap, and the honest sentence is "the rest is distribution, not a setting".
A recommender that always finds something worth doing trains its reader to stop believing
it — so when execution defects are open and the measurable findings total under 0.05
points, the headline leads with **"fix what is broken before tuning what is merely
small"** instead of ranking the small thing first.

## 2026-09-12 — two risk controls that fail open, and said nothing

A sweep of every `catch` on the trading paths found 56. Most are fine: they
return a typed failure the caller journals, or warm a cache. Two are different
— they leave a RISK CONTROL weaker and write nothing.

**Buying power** (`liveExecute.ts`). `undefined` buying power means "no
constraint" to the sizer, so a broker read that throws — or simply answers
not-ok, which was equally silent and is more likely — removes both the
buying-power bound and the exposure headroom for the rest of the batch. The
comment read *"leave undefined — unconstrained, exactly as before"*, which is a
compatibility argument, not a safety one.

**Correlated exposure** (`riskCheck.ts`). A daily-candle fetch that throws
leaves that position's `r` null, and the sum skips a null — so a provider
outage makes the correlated-exposure cap UNDER-COUNT and admit a position it
would otherwise refuse.

The second one was also the computed-and-never-consumed pattern again:
`correlatedNotional` returned `correlations` carrying exactly the `r: null`
signal that a lookup had failed, and all three callers destructured
`{ amount }` and discarded it.

**Neither behaviour changed, and that is deliberate.** Failing closed would be
worse: one bad fetch, or one broker hiccup, would stop the book. What was wrong
is that the weakening was invisible. Both now journal once per ET day —
`live_buying_power_unavailable` and `correlation_data_unavailable`, throttled
because an outage affects every candidate on every tick — and both are in
`EXECUTION_ACTIONS`, so the leak scan reports them with recency and the advisor
ranks them.

`correlatedNotional` also returns `unresolved` now, so the count is a value a
caller can read rather than a shape it has to re-derive.

## 2026-09-12 — the options sleeve was invisible to every measurement

The plan counts the short-dated options sleeve as part of the 3%: its paper
book averaged +17% of premium over 20 trades. Over 2026-09-08..09 the LIVE
sleeve refused **29 of 31** candidates with `failedRules[0] === 'quantity'` —
the check whose own message reads *"risk budget is too small to size even one
contract at $2.93 premium (risking 70% of it)"*. Two orders got through.
Nothing reported the other twenty-nine, because every instrument here is
equity-shaped:

| surface | covered the options sleeve? |
| --- | --- |
| paired attribution | no — it matches paper EQUITY entries to live EQUITY entries |
| `EXECUTION_ACTIONS` | no options entry class at all |
| tune advisor | the word "options" appeared **zero** times |

**It is not a defect.** One contract of a $2.93 option risks $205 at a 70%
disaster stop, against a per-trade budget a fraction of that. It is arithmetic
on a small account, so it is reported as a `configuration` finding with the
binding number said out loud rather than left to be derived:

```
largest affordable premium is $1.57/share — unchanged by probation
(0.5x, 8 trades left), which scales the contract COUNT with a
one-contract floor and so cannot lower what a contract may cost
```

The ceiling reconciles the deployed order cap exactly: equity $3,522.81 ×
(2.5% × 1.25 expectancy lean, which applies because `methodWeightingEnabled`
is on) ÷ 70% ÷ 100 = $1.57/share, and `ceil($1.57 × 100 × 1.5) = $236`.

(That sentence originally read "HALVED by probation … lifts to $3.14", and the
code behind it multiplied the ceiling by the probation factor. Both were wrong
— see the 2026-09-12 section below. The reconciliation immediately above was
always computed from the UNHALVED figure, so the section contradicted itself
within four lines.)

**And the advisor read ONLY execution findings**, so the entire `configuration`
class — frozen caps, tuner rows that should not exist, suspect equity reads,
and now this — never reached the advice. It does now, with no estimate for the
same reason an execution defect gets none: a constraint costs whatever the
trades it refused would have made, which a count cannot tell you. A `research`
lever comes back as `needs_data`, because this is a decision to take (wait out
probation, trade only names whose premium fits, or judge the sleeve unsuited to
an account this size) rather than a value to set.

### The guard that should have caught it had two blind spots

`journalActionsReachability.test.ts` exists to catch a filter on an action no
emitter writes. It could not see either side of this:

- **Emit side.** It matched only the `action:` property form, so the four
  actions written through `journalEntrySkipOncePerDay` (a positional argument)
  looked unwritten. Adding `live_options_risk_blocked` to a filter therefore
  failed the guard against a live emitter.
- **Consume side.** It matched `actions: [ … ]` literals, so `actions:
  SKIP_ACTIONS` — a bare constant — matched nothing. Every skip action the
  attribution filters on was unchecked, which is the dangerous direction: a
  genuinely dead filter among them could never have been reported.

With both fixed the guard immediately found one: **`live_entry_cutoff_skipped`
has been in `SKIP_ACTIONS` since the list was written and nothing has ever
emitted it** — the equity entry cutoff is gated on a measurement and was never
built. Removed; when the cutoff ships, its PR adds the action to both sides at
once.

One false positive was fixed on the way: resolving a constant took every quoted
string in the array, so `EXECUTION_ACTIONS`' `splitOn: 'reason'` read as an
unwritten action. An array of objects keyed by `action:` now yields only its
action values.

## 2026-09-12 — the biggest red-day driver was a recording gap, not a loss

Decision 9's red-day decomposition, read on the live book:

| reason | total R | trades | |
| --- | --- | --- | --- |
| **unknown** | **−4.32** | 3 | −1.44R each |
| stop | −3.29 | 4 | |
| manual | −2.44 | 3 | |
| time_exit | −2.27 | 8 | |

`unknown` was the LARGEST driver, and at −1.44R per trade it is worse than an
actual stop — which reads like trades blowing through their stops, exactly the
execution failure Decision 9's yardstick names.

It is not. `unknown` is `exitReason ?? 'unknown'`: the reason was never
recorded. 35 of 117 live autotrade positions (30%) have a null exit reason, and
every one of them closed between **2026-07-13 and 2026-08-24** — none in
September. Exit-reason recording was fixed, and it works; the forty-session
window is simply still carrying the gap.

Same disease as the execution findings above, one table over, so the same fix:
`redSessionDrivers` entries carry `lastSeenEtDate`. A driver that stopped
contributing weeks ago is history the window is still showing, not something to
act on — and `unknown` in particular is a gap in the RECORD rather than a way
of losing money, which a reader cannot tell without the date.

## 2026-09-12 — the identity estimates high, and nothing checked it

`expected day % = trades/session × risk% × avg R` uses the **configured** risk
%. The book routinely risks less than that, and only less: the step-down after
two losers, the finish-line trim, the grade and method expectancy multipliers,
the regime cut, buying-power sizing and whole-share rounding all cut the size,
and none of them raise it.

Measured on the live book (117 closed autotrade positions, risk taken from the
INITIAL stop, which is what `initialRiskOf` uses):

| | |
| --- | --- |
| realized risk, median | **0.95% of equity** |
| realized risk, mean | 1.00% |
| configured risk at the time | 1.25% |
| ratio | **0.76** |

So the identity overstated the expected day by about a third. That does not
cost money directly — the review keeps or reverts on recorded daily results,
not on the estimate — but every statement of the form "the goal is N expected
days away" and every "this closes X% of the gap" in the tune advice was
reasoned from a number 30% too generous.

**The app had both figures all along and compared neither.**
`impliedDailyGainPct` is the estimate; `autotrade_daily_results.strategy_gain_pct`
is what the book actually produced, with no deposits and no manual trading in
it. The advice now carries `gap.measuredMeanDayPct` over
`gap.measuredSessions`, and the headline says — once, plainly — when the two
disagree by more than 0.1 points, ending with *"trust the measurement"*.

Two guards on it: active sessions only (a day with no trades is not evidence
about what a trading day produces), and a floor of
`MIN_CALIBRATION_SESSIONS = 5` recorded sessions, because a handful of days is
noise and letting noise overrule the identity is the opposite failure.

A measurement error in the honest direction is worth stating: the first pass at
this used the CURRENT stop rather than the initial one and reported a ratio of
0.38 — a ratcheted stop makes current risk near zero, which is the mechanism
working, not a sizing failure. The number above is the corrected one.

## 2026-09-12 — the review clock was counting a session that was not the trial

Decision 7 is the mechanism that decides whether the 3% trial is kept or
reverted, over "10 active sessions since the change". On the deployed box it
was counting **2026-09-11** as trial session 1: a session that ran the OLD
1.25% sizing, and a day the account moved −31.32% on manual trading.

**Why.** `sizingChangedOn` reads a `sizing_changed` journal row. No such row
exists — the config route that writes it deployed *after* the config was
changed, so the very trial that needed the row is the one without it.
`reviewSessions` then fell through to its fallback: every session the loop
recorded live, identified by having an account baseline. Its comment asserted
this "cannot over-count the window with sessions from before the change". It
can, and did — the daily-results recorder deployed exactly one session before
the sizing changed, so that one session qualified.

**The fix is not a better guess.** `autotrade_daily_results` gains
`risk_per_trade_pct`: the sizing that was in force on the session. The review
window becomes "sessions that ran the sizing being reviewed" — true by
construction, needing no journal row, and self-healing for any future change.
Three rules make it safe:

- A **null** risk (recorded before the column, or backfilled) is never a match.
  Unknown is not "the current sizing", so a backfill can never pad the count.
- A **correction** for a past date keeps whatever sizing that day ran under.
  Stamping today's onto it would be exactly the fabrication the column exists
  to avoid.
- The **journaled date still wins** when present: it is the more precise fact,
  and it separates two trials that happen to use the same risk %.

The 2026-09-11 row keeps its null, so the trial's count now starts from zero
and the first real trial session will be Monday 2026-09-15.

## 2026-09-12 — the last silent refusal on the live entry path

Auditing every early exit in `runLiveExecution` for a journal row left exactly
one that refused a candidate and wrote nothing:

```ts
if (skipSymbols.has(symbol)) {
  outcomes.push({ symbol, ok: false, reason: 'Already has an open live position' });
  continue;
}
```

Two reasons it matters more than it looks:

1. **It fed the residual bucket.** A paper entry the live book passed on for
   this reason reached the attribution as `no_live_row` — "nothing the journal
   explains" — pooled with genuine recording gaps.
2. **`skipSymbols` is not autotrade-only.** It is every open position on the
   account plus every working order, so a name the OPERATOR holds by hand
   silently suppresses every live signal on it for as long as they hold it.
   Nothing anywhere said so.

It is now journaled as `live_symbol_held_skipped`, once per symbol per ET day
(`journalEntrySkipOncePerDay` — a held name is a steady-state condition that
would otherwise write a row every tick for the whole hold), with a `holder`
field of `autotrade` / `manual` / `pending_order`. The three are not the same
finding and must not pool: an autotrade hold is the book working as designed, a
manual hold is the operator unknowingly muting a name, and a working order is a
transient that clears in a tick or two. (A fourth, `options_sleeve`, was added on
2026-09-23: until then the options sleeve's own contracts read as `manual`. See that
day's (twentieth) section.)

The advisor gives this class **no config field** on purpose. One position per
symbol is a structural rule, not a setting; the levers that change how often it
bites are the slot count and the hold time, and which applies depends on the
`holder`. A `code` action asking for that breakdown is the honest
recommendation, not a number to turn.

## 2026-09-12 — the scan was reading 1,000 of 1,928 skip rows, and said nothing

The tune advisor's top recommendation, at strong confidence, was **"the live
book refuses 102 trades on nothing the journal explains; paper made money on
them"** — 0.247 points of the expected day. It was an artifact of a `LIMIT`.

**How it was found.** The attribution's own numbers do not hang together:
`liveTrades: 102`, `paperTrades: 128`, `pairedTrades: 7`. If only 7 paper
entries paired, roughly 95 live trades paired with nothing either — so
`no_live_row: 102` could not be "102 refusals". Pulling both books off the
deployed box and comparing entry stamps directly: of 108 closed paper rows, 64
have no live row at all on that symbol and date, and the 44 that do sit a
**median 1,726 seconds — about 29 minutes** — from the nearest live entry. Only
7 fall inside the ±60 s pairing tolerance, which is exactly `pairedTrades`.

Two hypotheses died on the data, and are recorded so nobody re-runs them:

- *The live `entryTime` is the fill, not the placement.* It is not:
  `liveExecute.ts` stamps `entryDate`/`entryTime` from the ORDER's
  `createdAt`, deliberately, with a comment saying why.
- *The live book is systematically LATE, buying after the move.* It is not.
  Live is **earlier** on 29 of 44 pairs (median −230 s) and its entry price is
  marginally **better** (median −0.112%). The two books simply take different
  signals on the same names through the day, in both directions.

**The actual cause.** `collectJournalSkips` asked `listAutotradeEvents` for
`limit: 1000`. That window held **1,928** skip rows (1,175
`symbol_reentry_cooldown_skipped`, 617 `live_risk_blocked`, 72
`live_short_skipped`, 56 `live_score_floor_skipped`, 4 + 4 others). The query
orders by `id DESC` and clamps to 1,000 internally, so the **oldest 928 were
invisible**, and every paper entry whose skip row fell outside that set
classified as `no_live_row` — a bucket whose entire meaning is "the journal
says nothing".

The cap was not news: `countAutotradeEventDays` has documented it for months
("caps at 1000 rows, and during market hours the busiest actions write that
many in ~3 hours"). Three collectors written in the same week walked into it
anyway. A comment saying what not to do is weaker than a function whose name
says what it does, so there is now
`listAutotradeEventsInWindow(filter, hardMax)`, returning
`{ events, truncated }`, and the scan's three analytic reads use it.

**Truncation is now loud.** `coverage.journalSkipsTruncated` rides on the scan
result, and the advisor downgrades a `no_live_row` recommendation to
`needs_data` when it is set — with the reason said plainly — and excludes it
from "everything measurable adds N points". A named skip reason is still
trusted under truncation: not fetching some rows makes "the journal said
nothing" unreliable, and does nothing to a row that WAS read.

Audit of every capped analytic read, against the same window:

| read | rows available | status |
| --- | --- | --- |
| journal skips | 1,928 | **was broken** — fixed |
| execution findings | 594 | latent (261 landed in one day) — fixed |
| `entry_extension_shadow` | 32 | fine — fixed anyway |
| short-shadow route | 72 | fine, left alone |
| regime readings | 4 | fine, left alone |

### The first production read, and what it caught (2026-09-12)

`GET /api/journal/tune-advice` on the deployed box, minutes after the deploy:

```
gap: target 3%, implied 0%, gap 3 points, avgR 0.0001, trades/session 5
     storedTargetR 1.2, goal reached on 4 of 16 active sessions (25%), 1R on 5
     activeSessionsSinceChange 1 of 10
```

The 25% goal rate is exactly the plan's estimate ("roughly one active session
in four"), and `activeSessionsSinceChange: 1` against `activeSessions: 16`
proves the distinction the sweep above added is real — a reader taking the
lookback figure would think the trial was sixteen sessions old on its second
day.

**And the top four recommendations were all already fixed.** 261
`live_options_exit_failed`, 147 `live_scale_out_blocked`, 62
`live_stop_adjust_blocked`, 11 `live_bracket_rearmed` — ranked `actionable`,
above everything measurable. Dating them against the journal: every exit
failure is from 2026-09-11, the HOOD day, with **none since the fill fix
deployed**; the scale-outs are 09-02/03/04/08, before the cancel-replace path;
the stop ratchets are the 09-02 DELL day. The execution window is ten sessions,
so a fix that lands on day one leaves nine more evenings of the same false
report — which is precisely how a reader learns to skip the section the
headline was designed to make trustworthy.

A count without a date is not actionable information. So an execution
occurrence now carries `lastSeenEtDate` and `sessionsSinceLastSeen`, counted in
SESSIONS rather than days (2026-09-07 is Labor Day: three calendar days from
09-11 to 09-14 is one session), and:

- a class not seen in the latest session ranks **below** the measurable
  findings rather than above them — still present, because dormant is not the
  same as fixed and the scan has no evidence a deploy happened;
- its action becomes "check whether the fix landed after `<date>`" rather than
  "root-cause these occurrences";
- the headline counts only classes seen in the latest session as outranking
  everything, and mentions the dormant ones in a single trailing clause;
- an occurrence whose recency cannot be established is treated as CURRENT.
  Silence is not evidence of a fix.

### The sweep that followed (2026-09-12)

Two of these in a row was enough to go looking deliberately rather than by
accident, across everything shipped on 2026-09-12. Three more, all the same
disease at a different layer:

- **`storedTargetR` had four derivations.** `targetDailyGainPct / riskPerTradePct`
  — the conversion that decides what "reached the goal" MEANS — was written out
  by hand in the sweep, the dashboard's goal-rate line, the leak scan's day
  level and the tune advisor, each with a comment asserting it matched the
  others. They did match, character for character, which is precisely how a
  divergence ships: add a clamp or change the rounding in three of four and the
  fourth quietly answers a different question. `goalInR()` in
  `dailyTargetSweep.ts` is now the only one, and a test asserts the number it
  returns is the level the sweep flags as the stored target.
- **The Automatic switches card taught a three-part rule and showed two parts.**
  Graduation needs sessions AND a proposal AND no contradiction; the card showed
  the session count and the contradiction count. A rule sitting at zero
  proposals — which can never graduate, however many sessions it accumulates —
  read exactly like one that graduates next session. It now says so, shows the
  graduation date, and shows when the engine last ran (a date that stops
  advancing is the only visible sign the after-close hook has stopped, while
  every count beside it keeps reading plausibly).
- **One journal action carried two severities.**
  `live_options_exit_reprice_deferred` covers the chase standing aside for a
  partial fill (`mid_fill`, benign and correct) and the chase having given up
  after its 20 re-prices with the order still resting (`daily_cap`, the HOOD
  failure mode recurring). The leak scan reported both under one label as an
  execution finding of equal weight, so the benign one would cry wolf every
  time a partial filled and the real one would hide behind it. The scan splits
  on the reason now, and an occurrence whose detail will not parse stays
  counted under the unsplit action rather than being dropped.

Also removed: two API client methods (`journalRecordDailyResult`,
`journalBackfillDailyResults`) with no caller anywhere. Both routes are
operator-invoked corrections run by hand, as the User Guide says; a wire method
with no caller drifts from the route it describes without anything noticing.

**Decision 9's yardstick got a field too, in the same pass and for the same reason.**
The plan's "least loss on red days" objective is measured as *mean red day ≤ −1.5%*, and
`ResultsAggregate` carried `worstDayPct` but no mean of the red days — so the routine
that reports it every evening would have had to recompute it from the rows, differently
each time anyone rewrote the prompt. `redDays` and `meanRedDayPct` are fields now, and a
test pins the case the worst day cannot see: one bad day among small ones and a run of
bad ones have the SAME worst day and the same red-day count, and differ only in the mean.
The unit is percent, over the calendar's window; the leak scan's `dayLevel.meanRedSessionR`
is R over the scan's window. They will not agree and are not meant to — quote whichever
the rule being applied is written in.

**The review clock is a field, not prose.** `gap.activeSessionsSinceChange` and
`gap.reviewSessionsRequired` are on every response. They were briefly available only
inside a blocked recommendation's `statusReason`, which is the same mistake this spec
keeps recording one layer up: the routine that reports the clock every evening would have
found it only on the days something happened to be blocked. It is distinct from
`gap.activeSessions`, which counts the whole lookback window — most of which predates the
trial — and the route integration test asserts both reach the wire.

**Where it does not go.** There is no Auto-page card. The advice is a daily *read*, not a
glance, and the page already carries four cards the operator scans; this one is delivered
by the post-close routine and available at `GET /api/journal/tune-advice`. It collects
nothing of its own — the goal evidence, the scan and the review window are all already
kept for their own reasons — so its numbers cannot disagree with the cards beside them.

**What it cannot do**, stated so nobody waits for it: propose a feature. A pure function
over the book's own record can rank what the record implies; it cannot notice that the
options sleeve has no attribution of its own, or that a gate would be better expressed
some other way. That half stays a judgement, made against the data and the codebase, and
the routine asks for it explicitly rather than pretending the advisor covers it.

## 2026-09-12 — the automatic re-arm could sell the position twice

The bracket-protection check learned to **re-arm** on 2026-09-12 (§"the exits are made
to fill"): a position confirmed naked at the broker — shares held, no resting stop — gets
a protective bracket placed from its own row's geometry instead of a journal line telling
a human to do it by hand. That was the right change. The way it placed the bracket was
not.

**Two states reach the re-arm, and it treated them as one.** The classifier above it
distinguishes a resting STOP leg from a resting TARGET leg, and it was added precisely
because they are not interchangeable: *"a bracket has TWO exit legs and only one of them
is protection. A position whose STOP was cancelled while its TARGET still rests was
reported protected — silently, forever."* So the check falls through to the re-arm in two
different situations:

| resting legs | what is missing | what the first re-arm placed |
| --- | --- | --- |
| none | stop **and** target | stop + target — correct |
| target only | stop | stop + **a second target** |

In the second row the new take-profit is for the same shares, at the same price, as the
one already working. Price reaches the target, **both fill**, and the account is short a
position nobody opened — the accidental short that `unreadableOpenOrders`' own comment
describes and that `cancelReplace.ts`'s five-step ordering exists to prevent, except
placed deliberately. And it fires on the **winners**: the duplicate leg sits at the price
the trade is designed to reach, so this is the expected path of a good trade, not an
unlucky one.

**The fix** is to pass only the leg that is actually missing. `buildStandaloneBracketRequest`
already emits just the legs it is given and returns `null` when given none, so a stop-only
re-arm needed no new placement code. `live_bracket_rearmed` now carries `legsPlaced`
(`'stop'` or `'stop+target'`) and `targetAlreadyResting`, so the journal says which shape
went on the book.

**What is knowingly left behind.** A stop re-armed alone carries its own
`client_combo_order_id` and is therefore *not* OCO with the old target leg, so a stop fill
leaves that target resting. That is the state the position was already in — it is what
made the alarm fire — it is strictly better than having no stop at all, and the close path
(`clearRestingBracket`) cancels resting exit legs before placing anything. Cancelling the
orphan target first and re-bracketing both would be tidier and would open a naked window
inside an alarm path, which is the trade `cancelReplace.ts`'s header already refused once.
The journal detail records the shape rather than leaving it to be inferred.

**Why no test caught it.** Every re-arm test mocked `listWebullOpenOrders` with
`orders: []` — all four of them, including the one named "never stacks a second bracket
after an UNANSWERED re-arm", which is about the same hazard from the other direction. The
branch with a resting target was never exercised, so the re-arm's *consumer* — the
argument list `webullPlaceStandaloneBracket` actually receives — was never asserted on it.
This is the same finding this document has now recorded several times in one day: a value
tested where it is computed proves nothing about what reads it. Two tests now pin both
rows of the table, and the stop-alone one fails on the old line with
`expected 110 to be undefined`.

**One stale comment, fixed with it.** `loop.ts`'s call site still described the check as
*"read-only, one open-orders pull, reports and never acts (see the function's own comment
for why auto-re-arming would be worse than the gap)"* — the exact opposite of what it had
done since that morning. It sits above the entry gates, so a reader working out what may
run before them was being told it writes nothing.

## 2026-09-12 — the biggest "unexplained" bucket was a gate doing its job

`no_live_row` is the attribution's bucket for *"the live journal says nothing about this
name at that minute"*. It is the largest untaken class on the book, the evening routine
watches it, and this document has already recorded one cause for it (the skip read was
clamped to 1,000 of 1,928 rows). Here is a second, and it is not a recording gap at all.

**One refusal on the live entry path names no symbol.** `evaluateEntryCutoff` runs *before*
the per-candidate loop — deliberately, so a doomed batch costs no broker round-trip — and
refuses the whole batch at once. Its row therefore carries a count (`refused: N`) and no
`symbol`. Two things then drop it on the floor:

- `collectJournalSkips` filters `e.symbol !== null`, so the row never enters the skip set;
- `classifyUntaken` matches `s.symbol === paperTrade.symbol`, so it could not have matched
  even if it had.

So every paper entry the live book declined because the end-of-day flatten was about to
swallow it came out as "nothing the journal explains". The plan's own design for this
classifier said `entry_window_closed` **(batch, by time)**; the implementation matched on
symbol like everything else and lost the one class that has no symbol to match on.

**Why it matters to the goal and not just to the report.** An unexplained hole in the
record and a gate working correctly point in opposite directions. The advisor ranks the
untaken classes by the paper R they left behind and proposes loosening whatever governs
them — so a correct refusal, filed as unexplained, argues for opening a gate that exists
to stop a specific, measured loss (ESTC opened 15:56:04 and flattened 15:57:12; three
entries on 2026-09-02 that turned +$32.78 into −$3.51).

**Matched by tick, not by a recomputed clock.** Both books decide inside one tick (paper
first, then live), so a batch refusal within `PAIR_TOLERANCE_MS` of the paper entry *is*
the refusal that would have taken it. A tick where the live book had no candidates
journals nothing and stays `no_live_row` — correct, nothing refused that name. A
symbol-named skip still wins when both cover the tick: it says more.

**And the bucket gets a real lever, because paper is the control by construction.**
`endOfDayFlatten.ts` keeps the entry cutoff live-only on purpose: paper flattens on the
same window but keeps *opening* late entries, *"which makes it the control group for the
question the live book cannot answer about itself: whether the cutoff is buying anything,
or just closing a quarter of the session."* The paper R of this bucket is precisely that
answer. So `fieldForUntakenReason('entry_window_closed')` returns `endOfDayFlattenMinutes`
with a detail that says the cutoff is **derived** (`endOfDayFlattenMinutes + max(15,
stagnationExitMinutes)`), that lowering the flatten window also holds open positions
closer to the bell, and that this bucket is a measurement rather than a gap. Without that,
the advisor's fallback would have printed "No single setting governs entry_window_closed",
which is false.

One consequence worth stating for the trial: Decision 2 moved `stagnationExitMinutes`
90 → 60, and the runway is derived from it, so the entry cutoff moved from ~95 minutes
before the bell to ~65 — half an hour of session the live book may now enter in. That was
a side effect of an exit change, not a decision about entries, and this bucket is where it
becomes visible.

**How big is it today? Zero, and that is worth saying plainly.** The deployed book carries
263 `entry_window_closed` rows over 8 ET days, spanning 14:25–15:56. But of 108 closed
paper positions only **13** were opened at or after 14:00 ET, and every one of those
predates the window it would have to land in (ROIV 09-08 at 14:02 against a 14:25 cutoff;
the rest are July, before the paper flatten shipped at all). So **none** of the 97
unexplained entries is an end-of-day refusal. The classifier is correct and the hole it
closes is real; the hole was simply empty on this book. It will not stay empty — the
cutoff moved half an hour later this week, and the paper book keeps opening late entries
by design.

## 2026-09-12 — three readers of one fact, agreeing on two of its three spellings

"Which resting leg is the stop?" is asked in three places, and until today they did not
give the same answer:

| asked by | via | accepts `STOP_LOSS` | accepts `STOP_LOSS_LIMIT` |
| --- | --- | --- | --- |
| the scale-out resize | `exitLegKind` | yes | **yes** |
| bracket protection | `classifyExitLeg` | yes | **yes** |
| the **stop ratchet** | inline `order_type === 'STOP_LOSS'` | yes | **no** |

`STOP_LOSS_LIMIT` is not a hypothetical spelling. The app places it: `buildWebullOrder`
builds it, `guardrails.ts` lists it among the three types Webull accepts, and
`webullReplaceBody` carries a dedicated guard against a replace *"converting a
STOP_LOSS_LIMIT into a plain STOP_LOSS — changing the order while claiming to move it."*

So a bracket whose stop rested as a stop-limit was a stop to two of the three readers and
invisible to the third. The ratchet would refuse it every tick for the life of the
position: no breakeven at 0.25R, no 0.5/0.5 trail, on a live position, silently except for
one journal row a tick. Breakeven and the trail are two of the six mechanisms Decision 9
names for keeping red days small.

**Latent, and said plainly.** The book's only `live_stop_adjust_blocked` rows are 62 of
them, all on 2026-09-02, all on DELL position 573, all reading *"no resting leg
identifiable as STOP_LOSS among 2 exit order(s)"* — a full session in which a position
that ran to +2.07R never moved its stop. Those predate the `order_type` fallback (shipped
2026-09-05, PR #505) and are explained by the `combo_type` nesting bug alone. Nothing has
been blocked since. This is fixed because the next spelling the broker uses should not
need a fourth edit in a fourth place, not because it is currently costing money.

**The fix keeps the layering that was already right.** `combo_type` stays the primary
filter rather than folding into the shared derivation: it is the more discriminating field
and the only one that can pick *this bracket's* stop out of a symbol that also carries a
standalone one (a re-armed protective stop, a hand-placed order). Reading both markers
equally there would see two stops and refuse a case that works today — which is exactly
what the test named *"does not let the fallback create an ambiguity combo_type had
resolved"* was written to protect. Only the **fallback** now calls `exitLegKind`, so it is
a superset of the old test in what it accepts and stricter in one respect: where the two
markers disagree on a leg it believes neither, rather than moving a leg it cannot describe
consistently.

**`classifyExitLeg` deliberately does not join them.** It is the same question with the
opposite direction of error. Bracket protection asks "is *something* protecting this
position", and being wrong there means stacking a second stop on a live one — so its safe
default is to read leniently and stay quiet. The ratchet asks "*which* order do I move",
and being wrong means dragging the target onto the price and selling the position at a
loss — so its safe default is to refuse. Merging them would have to pick one of those
defaults for both. The comment at each site now says so, so the next reader does not tidy
it into a bug.

**The refusal now names the leg shapes.** Sixty-two identical rows in one session said
only "among 2 exit order(s)", so telling *"this bracket genuinely has no stop"* from
*"neither marker parsed"* needed a reading of the source rather than of the journal. The
reason string now carries `comboType/orderType` per resting leg — e.g.
`[?/LIMIT, NORMAL/?]`.


## 2026-09-12 — the same hole, one level up: the live book standing down

`no_live_row` was still 97 after the cutoff class was wired up. Measured against the
deployed book, **14 of them are the live book standing down on a day the target had
already banked** — all on the three ET days `daily_target_reached` fired.

`runAutotradeLoopTick` sets `summary.skippedReason` only when NEITHER book is active. When
**live alone** stands down — the day banked, the give-back guard fired, the kill switch,
live trading switched off — the tick simply runs `if (paperStillActive) {...}` and skips
`if (liveStillActive) {...}`. Paper trades. The live path journals nothing at all: not a
batch row, not a per-symbol row, nothing. The attribution then pairs each paper entry
against the live book, finds no twin and no journal row, and files it under "nothing the
journal explains".

**This one gets worse as the strategy gets better.** Banking the day at +3% is the plan's
goal, and the halt after it is the goal being *met*. Every additional +3% day would have
added paper entries to the unexplained bucket — and the advisor ranks unexplained flow as
the next gate to go and loosen. A day the strategy succeeded was accumulating evidence
that it leaks.

So the loop now journals `live_entries_halted` with the reason (`daily_target_reached`,
`give_back_halted`, `kill_switch`, `live_trading_disabled`, `live_entries_inactive`), the
day's gain and target, and the count of signals it refused. Per tick, and only when there
were signals to refuse — the attribution matches these by time, so a once-a-day row could
not classify the tick a paper entry landed on, while a row on every empty tick would be
three hundred a day of noise. It mirrors `entry_window_closed`'s `refused: N` exactly.

**It is a bucket, never a recommendation.** `tuneAdvisor` skips this class outright rather
than ranking it low. Its only honest lever would be "stop banking the day", which Decision
2 settled, and a rule that gets louder the better the book performs is worse than no rule.
It still appears in the attribution, where it explains the paper entries it explains.

**The classifier is now general.** `classifyUntaken` takes a list of `BatchRefusal`
`{at, action}` rather than one array of cutoff timestamps, and returns whichever batch
action covers the tick. A symbol-named skip still wins when both cover it — it says more.
Adding the next symbol-less refusal is now one entry in `BATCH_REFUSAL_ACTIONS`, and
`journalActionsReachability.test.ts` fails if the emitter and that list ever disagree
(verified by renaming the emitter: the guard reports
`live_entries_halted (read in edgeLeakScanData.ts)`).

**What is left in `no_live_row` after both.** 32 of the remaining paper entries are on ET
days the live book made **no autotrade entry at all** — 22 of those in July, before live
autotrade was really running, inside a 40-session window that reaches back that far. That
is a coverage fact about the window, not a leak, and the next thing to measure rather than
the next thing to fix.

## 2026-09-12 — 15% of the live record is excluded from every measurement, and nothing said why

`dailyGoalEvidence` on the deployed box reads `droppedTrades: 18` against 99 scored
trades — roughly 15% of the live book excluded from the realized edge, the mean day, the
goal rate, and every dimension of the leak scan. The number is honest. It is also a count
with no cause, which is the third time this document has recorded that shape in a week
(the red-day drivers, the execution findings, and now this).

It matters because the six ways a trade can be dropped are not the same kind of fact:

| cause | what it means |
| --- | --- |
| `noEntryOrExit` | closed with no exit row, or no entry date — not a usable trade |
| `noEntryTime` | a history gap; adoption only began stamping `entry_time` on 2026-08-31 |
| `noInitialRisk` | **no recorded stop**, or a stop not below the entry |
| `unparseableExit` | an exit date that could not be placed on the clock |
| `optionsIncomplete` | an options row missing an exit price, time, or risk amount |
| `noAttributes` | scored in R, but the leak scan could not join its per-trade attributes |

`noInitialRisk` is a risk fact — those positions had no risk denominator because they had
no stop — and `noEntryTime` is a fixed history gap that needs nothing. A single 18 cannot
tell them apart, so the operator reading "18 dropped" has no way to know whether to look.

`DropReasons` now travels with the count, through `CollectedTrades` → `RealizedEdge` →
`dailyGoalEvidence`, and through `CollectedLeakBook` → the scan's `coverage` as
`liveDropReasons` / `paperDropReasons`. The total is `dropTotal()` of the split rather
than a second counter kept beside it, so the breakdown and the number cannot disagree —
the same rule CLAUDE.md states for any two derivations of one quantity, applied before
they had a chance to drift.

One ordering is pinned by test because it is not obvious: a row with no exit is dropped
for *that* reason before its stop is ever looked at, so a position with neither reads as
`noEntryOrExit`, not `noInitialRisk`. The first version of that test asserted the other
way round and was wrong.

No web change: the Auto page carries `edgeLeakSummary`, not `coverage`. This is read by
the evening routine and by the route, which is where the question gets asked.

## 2026-09-12 — the engine's safety model rested on a label, and the label was wrong

The gated-switch engine's entire safety model is one sentence: **a rule that adds exposure
is never applied by the app.** Its own header says `direction` is *"checked in three places
rather than one."* All three check the same thing — the `direction` **field** — and for one
rule that field is attached by a different module, to data, describing an intent rather
than an arithmetic.

`leak_lever` reads a field name and a number off whatever the last scan put in a
`LeakLever`, confirms the key is on `SWITCH_WRITABLE_KEYS`, confirms the value differs from
the stored one, and applies it. `assertWritable` — whose own comment draws exactly this
distinction, *"a patch assembled from a leak scan's lever is data, not literal code"* —
checks **which key** may be written and never **which way the value moves**.

**It was reachable, with the numbers already in the source.** The scan's score-band lever:

```ts
value: bucket === '<60' ? 60 : 70,
direction: 'safe',
detail: 'Raise the live-only score floor above the losing band…'
```

An **absolute** floor where the detail says *raise*. Production's `liveMinSignalScore` is
**72**. So a losing 60-69 band proposes `liveMinSignalScore: 70` — a **drop** that admits
trades the live book currently refuses, labelled safe, applied to real money by the app
itself once the rule graduated its shadow. A test with the guard removed confirms the
engine applies it.

The producer cannot fix this: `lever` has the signature `(bucket) => LeakLever` and the
scan is never handed the config, so the current floor is unknowable there. That makes the
write the only place it can be checked — **assert at the consumer, not the producer**,
precisely as CLAUDE.md states it.

**`SAFE_DIRECTION`** now declares, per writable key, which way is less exposure — including
the two that read backwards (`symbolReentryCooldownMinutes` and `liveMinSignalScore` are
safer *higher*) and the one that is easy to get wrong (`maxDailyDrawdownPct` **lower**: a
wider halt lets the day keep losing). Three keys are `'either'` — not exposure knobs on
their own — and a data-sourced rule may not write those at all.

**Scoped to data, deliberately.** `sizing_revert` restores the 2026-09-11 settings as a
**set**: risk, exposure, aggregate and halt all come down, but `expectancyMaxMultiplier`
1.25 → 1.5, `stagnationExitMinutes` 60 → 90 and `symbolReentryCooldownMinutes` 390 → 120
each move toward more exposure on their own. It is safe because it is a known-good prior
configuration, not because every field points the same way — which is why the guard keys
off `patchFromData` rather than running over every patch. A test asserts both halves: the
revert *would* be refused as data, and is not, because it is literal code.

**The coherence half, which the plan asked for and did not get.** Workstream 7 specified
that an auto-applied patch goes *"through the same validated path the PUT route uses."* It
goes through `setAutotradeConfig` directly, which sanitizes fields one at a time and has no
view of a pair. Of the route's four ordered pairs and its goal triple, exactly one has a
writable side here: `expectancyMaxMultiplier`. Inverted against its min, the route answers
400 with *"every conviction grade would size at the same multiplier"*; written straight to
the row it fails nowhere and every grade silently sizes alike. Not reachable today — no
lever names that field — which is exactly when it is cheap to close. `coherenceGuard`
applies to **literal** patches too: a rule is trusted with its own direction, never with a
config the route would reject.

**Refusing to act is not refusing to report.** A refused patch still journals
`config_change_proposed`, and the refusal text leads the `blockers` list — "this adds
exposure" is a different answer from "this rule is still shadowing", and it is the one that
needs reading. The scan's lever detail now also says the number is a floor to raise **to**,
never a value to drop to, so a human applying it by hand gets the same warning.

## 2026-09-12 — two pieces of live-path process state with no way to clear them

`CLAUDE.md` and `test/setupProcessState.ts` between them describe this class at length: a
module-level Map or Set lives for the whole worker process, outlives not just a test but a
**file**, and `DELETE FROM …` does not touch it. The rule they settle on is that a file
which warms such a cache resets it in its own `beforeEach` — which requires the module to
export a seam. Two in the live path did not have one.

**`equityGuard` (`liveExecute.ts`) had no reset at all.** It holds the equity-sync guard's
corroboration state: an out-of-band net-liquidation reading is refused until three
consecutive readings agree at the same level, and the counter lives here. In production the
module's own comment is right — a restart costs a few extra ticks and never accepts a bad
reading. Across tests it is the leak class, and there was no way for a file to clean it up
even knowing it should.

What leaks, concretely: the 2026-08-27 regression test drives the spurious $2,444.70 print
twice, leaving `{ pendingUsd: 2444.70, pendingCount: 2 }`. **Two of three.** Any later test
making an out-of-band reading within 1% of that level is the third corroboration, so the
guard *accepts* it — writes it to `accountEquityUsd`, and, because
acceptance-after-corroboration is the signal an external cash flow needs, calls
`applyExternalCashFlow` and moves the day's baseline. A test written to assert a refusal
would see a write and a rebased day. Benign today only because the later figures in that
file are 50k and 74k, nowhere near 2444.70 — a coincidence, not a design.

The new test proves the seam rather than exercising it: two rejections, a reset, then a
third reading at the same level. With the reset stubbed to a no-op it fails with
`expected 2444.7 to be 2234.58` — the third reading accepted, which is the bug.

**`killSwitchHeldPositions` (`liveOptionsExecute.ts`) had a reset that did not cover it.**
`resetLiveOptionsExitChaseState()` cleared `exitRepricesByPosition` and nothing else, under
a name specific enough to read complete. The Set is cleared in production only when a halt
ends, so a file that leaves an id in it hands that id to the next file — and position ids
restart per test file, so they collide by construction. A collision means the later file's
held position journals nothing, because the Set says it already did. Renamed to
`resetLiveOptionsProcessState()` and it now clears both: a reset whose name promises less
than it does is how the next piece of state gets left out again.

**One correction worth recording.** The first version of this change also reset the guard in
`autotradeLoop.test.ts`, on the reasoning that it runs next under the pinned path order.
That file `vi.mock`s the whole of `liveExecute`, so the real module state is never touched
there and the reset is neither possible nor needed — the import failed with *"No
`resetEquitySyncGuardState` export is defined on the mock."* Of the six test files that
reference `liveExecute`, four use the real module and two mock it; only
`autotradeLiveExecute.test.ts` drives the equity sync for real.

## 2026-09-12 — the screener was dropping an eighth of the universe to rate limiting

`screen_data_incomplete` exists because, before 2026-08-24, symbols the provider refused
were silently discarded: *"~7% of a 560-symbol universe was vanishing from every scan with
nothing recorded, so a name that would have qualified could be missed all session and leave
no trace."* Recording it was the right first step. Reading what it now records is the
second, and nobody had:

| ET date | ticks with an incomplete scan |
| --- | --- |
| 2026-09-09 | 140 |
| 2026-09-10 | 201 |
| 2026-09-11 | 192 |

The latest row: **67 unscored of 562 scanned**, `sampleMessage: "Too many requests"`. Twelve
percent of the universe, on essentially every tick of every recent session, and rising.

**This is the flow term of the plan's own identity**, not a reporting nicety. `expected day
% = trades/session × risk% × edge R`. A symbol that is never scored cannot become a
candidate, so an eighth of the book's opportunity is discarded before any gate forms an
opinion — and unlike every gate, this one leaves no per-symbol row, so it is invisible to
the attribution, to the leak scan's untaken classes, and to the tune advisor. The trial is
raising risk to chase a bigger day while the number of shots per day is being quietly
reduced by a provider limit.

**The fix is one bounded retry.** The per-symbol body is hoisted out of its `mapPool`
closure (unchanged, purely hoisted) so the same function can run again over just the
refused symbols. Deliberately narrow:

- only errors that *look* like rate limiting (`isRateLimited`), so a symbol whose data is
  genuinely broken does not cost a second round trip on every tick of every session;
- **one** pass, never a loop — a provider that stays refused is reported, not hammered;
- a lower concurrency (3 vs 6) after a 1.5s pause, because a retry at the same rate as the
  burst that was refused is just the burst again;
- the retried entries are removed from `errors` first, so a symbol that succeeds on the
  second attempt is not also reported as unscored.

Re-running the same body is safe by the function's own structure: every filter before the
`try` returns early and never reaches the `catch`, and the only pushes inside it happen on
the success path immediately before it ends. A symbol that threw has recorded nothing, so
it cannot be double-counted.

**One comment corrected with it.** `providers/webull/client.ts`'s pacing header read
*"Market data is left alone: separate limits, its own caching layer, and no observed
problem."* There is an observed problem, 533 journal rows of it. The claim is the kind that
stops the next reader looking, which is most of why this went three sessions unread. The
comment now says market data IS rate-limited, that it is not that client's surface (the
screen goes through the market provider, not the trade one), and where it is handled
instead.

## 2026-09-12 — the pre-committed review was reading the wrong series

Decision 7 is the trial's safety catch: at 10 active sessions, **revert if the mean day is
negative**. It computed that mean from `dayPctOf` — `accountGainPct ?? strategyGainPct`,
the **account** figure first — and then tried to subtract the contamination afterwards with
the `manualTrading` flag.

The one session on the book carrying both numbers shows the size of what that rests on:

| 2026-09-11 | |
| --- | --- |
| account | **−31.32%** |
| strategy | **−1.96%** |

A sixteen-fold difference, with a live-money sizing revert on the other side of it and a
single boolean in between.

**The right series was already in the row.** The account figure carries deposits,
withdrawals, hand trading, and the unrealized mark on anything still open at the close. The
strategy figure is realized P&L on positions the loop itself opened and closed, over the
same baseline — immune to all four by construction. `dailyResults.ts`'s own header says
which is which: *"A strategy decision is made on the second (OPTIONS_TUNING_PLAN's
data-quality rule — a position-derived series carries no flows)."* Decision 7 is a strategy
decision. It was reading the other series.

**A threshold is not a substitute for the right input**, and this one was wrong in both
directions. `manualTrading` fires at 0.5% of equity — on a $3,523 account, **$17.60**. Hand
trading below that was never flagged and flowed straight into the mean. And it fires on
clean days too: options are deliberately *not* flattened at the close
(`endOfDayFlatten.ts`), so an open contract's mark can cross 0.5% on its own, and at the
sleeve's current sizing (a $236 cap on $3,523 equity, 6.7%) an 8% move in one contract does
it. The same number admitted real contamination and threw away real sessions — out of a
review that is only **ten sessions long**.

**The fix is one line each way.** The mean reads `strategyGainPct` and drops *no* session:
a manual day's strategy percentage is still exactly what the loop did. And the manual
exclusion moves to the **goal rate**, which is where it always belonged and where it was
missing — `goalReached` is stamped when the *account* equity crosses the target, so a
deposit or an afternoon of hand trading can bank a day the loop did not earn (2026-08-27
banked a fictional +9.69% on a spurious equity print). A day whose two figures disagree
cannot say whether the strategy reached the goal, so it is counted neither way.

`dayPctOf` is left alone for the calendar, where account-first is correct: that page answers
"how am I doing", which is the question the account figure is for. The two readers now
differ on purpose, and each says why.

**Worth recording about the window as it stands.** Of 26 backfilled sessions, 25 carry
`accountGainPct: null` *and* `strategyGainPct: null` — they predate the baseline row, so
there is no opening equity to divide by, and the backfill filled dollars rather than
percentages. The 26th is the manual day. So today `meanDayPct` is `null` and the mean-day
revert cannot fire at all; it is not a defect (`reviewSessions` correctly counts zero
sessions under the trial's sizing, and rows from 2026-09-15 carry both figures), but it is
worth knowing that the criterion has never yet had an input.

## 2026-09-12 — the reachability guard had a third direction, and it found four more

`journalActionsReachability.test.ts` asks one question: *is every action a reader filters on
actually written by some emitter?* That catches a dead filter. It does not catch the
reverse, and for one family the reverse matters just as much.

An **entry skip** that is written and that the attribution cannot classify sends its paper
twin into `no_live_row` — the bucket meaning "nothing the journal explains". The refusal is
recorded, correctly, per symbol, through the same throttled writer as every classified one,
and it still reads as a hole in the record. This document has now spent three sections on
that bucket; this is the largest remaining piece of it.

**Three equity refusals were journalling and going nowhere:**

| action | why it was missed |
| --- | --- |
| `regime_score_floor_skipped` | `liveEntryScoreGate` returns **one of three** actions from one code path; the other two were in `SKIP_ACTIONS` |
| `risk_atr_unreachable_skipped` | 1R wider than the name's daily range — its own comment says paper keeps taking these *"so the experiment has a control group"*, which is exactly what the attribution is |
| `symbol_unplaceable_skipped` | the broker refuses to parse the symbol |

Two now carry a lever (`mlRegimeHighVolMinSignalScore`, `maxRiskAtrFraction`, both
exposure-direction so they are reported and wait); the third has none, and says so — no
setting makes a symbol the broker cannot parse tradeable, and taking it out of the universe
is a decision about the universe rather than about risk.

**The guard is the finding, not the three fixes.** It asserts that every action written
through `journalEntrySkipOncePerDay` is either in `SKIP_ACTIONS` or on a short allowlist
where each entry carries a written reason — the same shape `configReachability` uses for
paper-only settings, so the list is the decision rather than the oversight.

It earned its place immediately: run for the first time, it failed on a **fourth** action,
`live_options_risk_blocked`, which the hand enumeration that found the other three had
walked straight past because its call site spans several lines. That one is a deliberate
non-class — the attribution pairs paper *equity* entries against live *equity* entries, and
the options sleeve is measured by `collectOptionsFlowFindings` instead — so it went on the
allowlist with that reason, which is the outcome the guard exists to force.

The scan also has a floor assertion (`entrySkips.size > 4`), because a guard whose regex
stops matching passes vacuously, and this file already carries two other floors for the
same reason.

## 2026-09-12 — the two books do not act in the same tick, and the pairing rule assumed they did

This is the answer to `no_live_row`, arrived at by measuring rather than by waiting for the
week's watch to report.

The attribution pairs each paper entry with a live entry on the same symbol and ET date
**within 60 seconds**. The premise was written down and reasonable: both books consume the
same `decision.signals` in one tick, paper first, so a twin should be seconds away and
anything further apart is a different decision.

**The deployed book says otherwise.** Of 39 paper entries that have a live entry on the same
symbol and the same ET date:

| gap | count |
| --- | --- |
| ≤ 60s (paired today) | **7** |
| 61s – 5 min | 1 |
| 5 – 30 min | 14 |
| 30 – 60 min | 10 |
| > 60 min | 7 |

**Median gap: 1,613 seconds — 27 minutes.** Minimum 10s, maximum 8,511s.

The books diverge for ordinary reasons, every one of them by design: paper has no buying
power to wait for and no slot to free; the live score floor is **72** against paper's **60**,
so live enters the same name later when its score rises; live's cooldowns and risk checks
defer entries paper takes at once; and a live entry time is the *placement* minute, not the
fill.

**It cost twice over.**

1. `meanDiffR` — the headline *"the live book is 0.27R worse per trade"* — rested on **seven**
   trades, far under any reliability bar, when 39 were available.
2. The 32 rejected pairs fell through to `classifyUntaken`, found no skip row in that minute,
   and were reported as **`no_live_row`**. A name the live book genuinely *traded* that day
   was being counted as an unexplained refusal — the opposite of what happened.

That second point is the one that matters. Three sections of this document have now chased
that bucket; between the batch refusals, the unclassified entry skips, and this, the
"unexplained" label was carrying at least four distinct things that are all explainable, and
the largest of them was not a refusal at all.

**Pairing is now on symbol + ET date, nearest in time, one live trade per paper trade.** That
is close to unique by construction: Decision 8 took the live book to one entry per symbol per
session. `medianPairGapMinutes` is on the report, so how far apart the two books read is a
number the operator sees rather than an assumption buried in a constant — and if that number
starts climbing, the pairing is drifting toward "two different decisions" and should be
questioned again.

`PAIR_TOLERANCE_MS` still governs `classifyUntaken`, and should: *"was a refusal journalled
at this minute"* is a different question from *"did both books trade this name today"*, and a
tight window is right for the first.

## 2026-09-12 — the control changed behaviour inside its own window

Almost every verdict the leak scan issues leans on the paper book. A bucket is a **leak**
only when *"the paper control's same bucket agrees in sign"*, and the attribution's whole
premise is that paper is what the live book would have done. All of that assumes the control
behaved the same way across the window it is read over.

It did not. The paper book gained the end-of-day flatten on **2026-09-05**, and inside one
40-session window it reads as two different books:

| | before 09-05 | after |
| --- | --- | --- |
| trades | 71 | 37 |
| overnight holds | **37 of 71** | **0 of 37** |
| mean loser | −0.837R | −0.721R |
| **mean R, all trades** | **+0.262** | **+0.013** |

A twentyfold difference in the control's own mean R, and more than half its earlier trades
were overnight holds the flatten now makes impossible. That is **larger than most of the
bucket effects the control is being used to confirm** — so "the control agrees" can be a
fact about *when* a bucket's trades happened rather than about the bucket.

This is the same disease as the dated counts two sections up, one level higher: not a count
without a date, but a **control group** without one. It touches the plan's own evidence —
Decision 8's round table ("round 1 +0.208R, round 2 −0.01R in the paper control") was
computed over a window that straddles this change, as was the `meanDiffR` headline.

**What the scan does about it: reports, never acts.** `coverage.paperControl` now carries
`earlyMeanR`, `lateMeanR` and `driftR`, measured by splitting the paper book at its **median
entry time** rather than at a hardcoded date — the point is to notice *any* drift in the
control, and a list of known behaviour changes is exactly the thing that goes stale. Below
eight trades it returns nulls rather than a number, because seven trades cannot tell drift
from noise and a confident figure there would be worse than none.

The scan does not have the standing to throw away two thirds of its own control, and
silently reweighting it would be a second undocumented change on top of the first. A number
the operator and the routine can both see is the honest move: when `driftR` is large, every
"the control agrees" verdict in that run is worth less than it reads.

## 2026-09-12 — a percent of premium is not a multiple of R

**The defect.** `computeFinishLineFactor` (finishLine.ts) decides whether the next live entry
should be trimmed near the daily bank line by comparing the gap still to go against what a
full-size winner pays:

```
fullRiskUsd = equity x riskPerTradePct/100     // DOLLARS OF RISK
fullWinUsd  = fullRiskUsd x rewardMultiple
```

The first factor is the per-trade risk budget — what the equity book calls 1R. So
`rewardMultiple` has to be a multiple of R, and on the equity path it is: `targetRMultiple`
places the target that many stop-distances away while the sizer spends exactly one
stop-distance of budget, so a 1R target really does pay 1R.

The options path handed it `optionsTakeProfitPct / 100`. That is a percent of **premium**, and
only `optionsDisasterStopPct` of the premium is the risk the budget bought. The sizer makes
this explicit: it sizes contracts so that a `disasterStopPct` loss of premium equals the risk
budget, so a take-profit fill pays `takeProfitPct / disasterStopPct` of that budget. At the
live 60 / 70 the trim read every options winner as paying **0.6R when it pays 0.857R** — a 30%
understatement, in the same direction every time.

**What it cost.** The trim is inactive while the gap to the bank line is at or above a full-size
win. Understating the win shrinks that band: at the live $3,522.81 equity and 2.5% risk it
engaged only inside $52.84 of the line instead of $75.49, and inside the band it trimmed to
`gap / fullWin`, a factor about 43% too generous. So a full-size options loser taken close to an
almost-banked day gave back more of that day than Decision 9's "red days stay small" allows —
the give-back the finish line exists to prevent.

**The fix.** One shared conversion, in `optionsAffordability.ts` (the module that already owns
the risk-budget-to-premium inversion, for the affordability ceiling):

- `optionsMaxLossFraction(disasterStopPct)` — the share of premium actually at risk, with the
  fails-safe branch (absent, 0, or >= 100 all mean "the whole premium"). It replaces the two
  hand-kept copies in `optionsRiskCheck.ts` and `maxAffordablePremiumPerShare`, each of which
  carried a comment saying the other must not diverge.
- `optionsRewardMultiple(takeProfitPct, disasterStopPct)` — the take-profit expressed in R.
  `liveOptionsExecute.ts` now passes the regime-tightened take-profit through it. The disaster
  stop is not tightened by the overlay, so the ratio falls with the tighten, which is the intent.

**Guarded at the consumer.** `optionsAffordability.test.ts` asserts the number the trim computes
against what the REAL sizer plus the REAL take-profit actually pay, over four equity / stop /
take-profit combinations — not against a copy of the ratio. The old basis fails that assertion
by the whole disaster-stop fraction. `finishLineWiring.test.ts` additionally scans the two
executors: the options one must go through `optionsRewardMultiple` and pass the disaster stop;
the equity one must keep `targetRMultiple`, which needs no conversion.

**Named, not fixed: the probation cut.** `liveOptionsProbationSizeMultiplier` multiplies the
risk-checked CONTRACT COUNT (with a one-contract floor) after the trim has run, so it is not a
sizing factor and cannot be folded into the basis as a risk %. At an equity that affords a
single contract the floor makes it a no-op — a flat 0.5 there would make the trim reason about
half a payoff the trade really produces. Where it does bind, the trim overstates the payoff and
trims slightly deeper than needed, which errs toward protecting the day. The call site says so.

## 2026-09-12 — a pre-committed rule that could never fire

**The defect.** The edge-leak scan's attribution reports `meanEntrySlippagePct`, and the
playbook's pre-committed rule beside it read: *"mean entry slippage above 0.5% is an execution
finding."* The quantity is `services/slippage.ts`'s `pct` — the fill measured against the order's
own LIMIT price. Every live equity entry is a **marketable limit**, priced
`MARKETABLE_LIMIT_BUFFER_PCT` (0.5%) through the quote so it behaves like a market order, and a
limit order fills at or inside its own price. So `pct <= 0` for every fill that has ever been
recorded or ever could be, on either side: a buy fills at most at its limit, a short at least at
its. **The rule could not fire on any book, in any market, ever** — and it read on the page like a
live check on execution quality. The same shape appeared in the scan's own fixture, which passed
`[0.3, 0.5]`, a pair of numbers no fill can produce.

**Why it matters.** The rule is the only pre-committed check on whether the entry PRICE is costing
edge, as opposed to the entry decision. With it unfireable, a book that had started crossing the
whole spread would have read the same as one filling at the quote: a comfortably negative number.

**The fix.** `marketableLimit.ts` now owns the buffer constant (`liveExecute.ts` imports it
instead of keeping a private copy — the scan needs the same number to read its own rows, and two
copies of a value that decides what a fill is measured against is the divergence CLAUDE.md's
"agree by construction" rule exists to stop). The attribution reports two more fields beside the
raw slippage:

- `entryLimitBufferPct` — what the limits were priced through, so the reading is self-explaining.
- `meanEntryBufferConsumedPct` — `buffer + slippage`, the share of the concession the fills
  actually paid away. **0** means every fill landed at the quote; **`buffer`** means every fill
  landed at the limit. (It under-states very slightly: `pct` divides by the limit rather than by
  the quote it came from — a quarter of a basis point at a 0.5% buffer. The quote at placement is
  not persisted, so a correction would be a guess; it is named instead.)

The scan raises `execution:entry_slippage` itself once 20 or more fills average past **half** the
buffer, so the check lives in the app rather than only in a document (Decision 11). Its lever says
to read the per-symbol rows first: one illiquid name usually carries such a figure, and excluding
that name is the cheap fix; a book-wide figure means the buffer or the order type is the thing to
change.

**The first reading.** 40 sessions to 2026-09-12: `meanEntrySlippagePct` **−0.45%** against a
**0.50%** buffer, i.e. **0.05% consumed** — well inside the bar, no finding. Execution is not
where this book's edge is going, and now that is a measured statement rather than an unreachable
one.

## 2026-09-12 — the review's red-day yardstick was only available in the wrong unit

**The gap.** Decision 7's pre-committed review is counted over *the active sessions since the
sizing changed*, and `SizingReview` is the object that holds those numbers:
`activeSessionsSinceChange`, `meanDayPct`, `goalRatePct`, `haltsMaxIn5`. Decision 9's yardsticks
travel with it — *mean red day ≤ −1.5%, worst day inside the halt* — and neither was there.

A reader therefore reached for the nearest red-day figures the app does produce, which are the
leak scan's `dayLevel.meanRedSessionR` and `worstSessionR`, in **R** over the scan's 40-session
window. Read beside a bar written in **percent** they invite a wrong answer, and the size of it
is not small: the deployed scan reads **−1.274R**, which looks like it clears −1.5% and is
**−1.59%** at the 1.25% risk those sessions ran and would be **−3.19%** at the trial's 2.5%. The
conversion between the two units is the risk % in force on each session — the one thing the trial
is in the middle of changing.

**The fix.** `SizingReview` gains `meanRedDayPct` and `worstDayPct`, off the same
`strategyGainPct` series `meanDayPct` already uses and through the same helper, so "the mean day"
and "the mean red day" cannot disagree about which sessions or which percentage they mean. A red
day is one with a negative strategy figure; `meanRedDayPct` is null (never 0) when none was red.

**Three windows now carry a red-day number, on purpose.** They answer different questions and
must not be swapped:

| where | unit | window |
|---|---|---|
| `ResultsAggregate.meanRedDayPct` (the calendar) | % | the calendar month/week being viewed |
| `SizingReview.meanRedDayPct` (the review) | % | active sessions since the sizing changed |
| `dayLevel.meanRedSessionR` (the leak scan) | R | the scan's 40-session lookback |

Decision 9's bar is written in percent over the trial, so the review's is the one it is applied
to.

**And one stale comment removed, on the field the revert turns on.** `meanDayPct`'s doc comment
still read "manual-trading days excluded" after the 2026-09-12 change that deliberately keeps them
(the manual exclusion belongs to `goalRatePct` alone, whose flag was the account-derived one —
since 2026-09-14 that exclusion is applied per row, off `goal_basis`). The
code was right and the sentence one line above it was wrong — the cheapest possible way to talk a
reader out of a correct number.

## 2026-09-12 — probation was named as the options sleeve's binding constraint, and it is not one

**The claim.** The leak scan's `configuration:options_unsizable` finding — the options
sleeve's only diagnostic, and it fires on 94% of that sleeve's candidates — multiplied the
premium ceiling by the probation size factor and said so: *"the largest affordable premium is
$0.79/share — HALVED by probation (0.5x, 8 trades left), which lifts to $1.57 when it ends."*
Its lever then offered, first among three remedies, *"wait for probation to end"*. The comment
in the code called the multiplication "the same halving the sizer applies".

**The sizer does not halve there.** Affordability and probation happen in that order and are
independent:

1. `optionsRiskCheck`'s `quantity` rule decides whether a candidate can be sized at all:
   `floor(riskDollars / (premium × lossFraction × 100)) >= 1`. Probation appears nowhere in it,
   and every refusal the finding counts is a `quantity` refusal.
2. `liveOptionsExecute` then scales the contract COUNT it was handed —
   `Math.max(1, Math.floor(rawQuantity × probation.multiplier))`. The floor is deliberate and
   its own comment says why: *"at one contract there is nothing left to cut."*

So probation changes how many contracts are bought, never the largest premium one contract may
cost. It cannot turn an affordable candidate into a refused one **at any account size** — and at
this one, where the sizer reaches exactly one contract, it changes nothing whatsoever.

**Why it mattered.** The finding pointed at the wrong cause and then recommended waiting it out:
advice to do nothing, about a sleeve refusing 94% of its candidates, with the reported ceiling
understated by half. The real constraint is the one the arithmetic in the same finding already
shows — equity. The lever now says that, and drops "wait for probation" entirely.

**Guarded at the consumer.** `edgeLeakScanData.test.ts` asserts the reported ceiling is
identical with probation active and inactive, drives a premium at the ceiling through the REAL
`computeRiskSizing` to show it sizes without probation in the arithmetic, and scans
`liveOptionsExecute.ts` for the one-contract clamp — the change that would make the ceiling wrong
again. The case it replaces asserted the halving, so the old behaviour was pinned by a test: a
reminder that a test only proves the code does what someone believed, and the belief is the part
worth re-deriving.

## 2026-09-12 — the scoring shadow nobody was reading, and what it says

**The gap.** `relvol_pace_scoring_shadow` has been journaled once per tick since the pace
scoring shipped behind `relVolUsePaceScoring` — roughly **200 rows a session**, on the deployed
box for weeks — with the decision rule written directly beside it in this spec: *"If
`wouldNewlyPass` and `wouldNewlyFail` are both small the change is cosmetic… If the set turns
over materially, then `liveMinSignalScore` has to be re-fitted against the pace-scored
distribution before the flag goes on."*

Nothing read it. Not the leak scan, not the tune advisor, not the daily routine. The reading
depended on someone remembering the row existed — the failure mode the Playbook's *"Rules that
apply themselves"* section and Decision 11 (*"leaks are found by the app, not by the
operator"*) are both written against. A measurement whose reading is a human's memory is a
measurement that gets read when someone remembers.

**What it says, read on the deployed box for the first time (2026-09-09 … 09-11, ~195 ticks a
session, ~480 symbols scored a tick):**

| | 09-09 | 09-10 | 09-11 |
|---|---|---|---|
| would newly **pass** / tick | 16.5 | 11.8 | 15.4 |
| would newly **fail** / tick | 0.66 | 0.65 | 0.01 |
| mean total score move | +2.20 | +2.01 | +2.31 |
| scoring **zero** on the relative-volume component | 357 → 242 | 361 → 245 | 382 → 243 |

Not cosmetic, and **one-sided**: roughly fifteen symbols enter the candidate set for every one
third of a symbol that leaves it — about **3% of the scored universe changing sides every
tick** — with the whole score distribution lifted about **+2.2 points**. A uniform lift of that
size against a floor fitted to the RAW distribution is a `liveMinSignalScore` about two points
lower than the one anyone agreed to. That is exactly what the spec's rule anticipated, which is
why the rule says re-fit first.

**What shipped.** `collectScoringShadowFinding` in `edgeLeakScanData.ts` averages the window's
rows and raises `configuration:relvol_pace_scoring_shadow` when the share of the scored universe
changing sides clears `SCORING_SHADOW_TURNOVER_PCT` (1% — about five symbols a tick, small
enough to catch a real turnover and large enough that noise does not report itself). It goes
silent on its own once `enabled` is true: the decision has been taken and re-reporting it would
nag about a choice the operator made.

**Its lever is `research`, deliberately, and can never be anything else.** The turnover widens
the candidate set, so enabling the flag ADDS exposure and is the operator's call under the
standing "safe direction auto, exposure on my word" rule — the app must never apply it. And the
re-fit is work to be scoped, not a knob to turn.

**Not done here:** the re-fit itself. `liveMinSignalScore` was fitted to the raw distribution
against realized P&L in PR #44; re-fitting it against the pace-scored one is its own piece of
work with its own evidence, and doing it in the same change that noticed the need would be
deciding the question by the act of measuring it.

## 2026-09-12 — two exposure ratios were wearing the risk sanitiser

**What it is.** `maxSectorExposurePct` and `maxCorrelatedExposurePct` gate capital
**already held** in a sector or in names correlated with the candidate. They are measured in
NOTIONAL and, by deliberate design in `riskCheck.ts`, they exclude the candidate's own size —
*"every symbol is trivially correlated with itself… position notional is typically many times
the $ risk, since sizing is risk-based off a stop distance"*. So they cannot be satisfied by
trimming an order; they are answered entirely by what is already open.

Both were validated `z.number().min(0).max(100)` at the route and clamped by the config
sanitiser's `pct()` helper — the same helper the genuine fractions-of-equity use (risk per
trade, the daily drawdown, aggregate open risk). Their real sibling is `liveMaxExposurePct`,
which measures the same quantity against the same denominator and has always been
`nonnegative()`. It sits at **190** in production.

**Why the clamp was a bug, not caution.** Notional-to-equity exceeds 1 on margin, routinely.
At the trial sizing — `riskPerTradePct` 2.5 over a 2% stop — a single position is **119% of
equity**. With the cap unable to exceed 100, *no legal value of either field could leave room
for a second name in the same sector*. The control could not express a coherent setting, and a
`PUT` of 150 returned **200 OK** and stored **100**: accepted, stored, wrong — the exact
failure shape CLAUDE.md's three config guards exist for, in a field none of them covers.

Probed on the deployed box at the live config: AAPL approved at $4,200 notional, MSFT then
refused with *"$4,200.00 already in Information Technology vs cap $2,818.25 (80% of equity)"*.

**The arithmetic, and why it drifted.** `concentrationCapFloorPct` (targetTune.ts) is the
smallest a notional concentration cap can be without contradicting the sizer: the per-order cap
as a percentage of equity — `sizerFloorFraction` (risk ÷ the widest stop) times
`ORDER_CAP_SIZER_HEADROOM`, the same two terms `deriveDollarCaps` uses for `liveMaxOrderUsd`,
so the two cannot drift apart. It moves when the sizing moves:

| | risk % | widest stop | floor | the 80% caps |
|---|---|---|---|---|
| before 2026-09-12 | 1.25 | 2.5 | **75** | coherent |
| the trial | 2.5 | 2.5 | **150** | one position fills the sector |

Nobody edited the caps. The ground moved under them when Decision 1 raised risk, exposure and
the aggregate together and left these two behind — which is why the scan now reports the gap
rather than trusting anyone to re-derive it.

**What shipped.** Both fields become `nonnegative()` at the route and `nonNeg()` in the
sanitiser. `configuration:concentration_cap:<field>` reports a cap below the floor, with the
floor as its lever value and `direction: 'exposure'` — raising a cap adds exposure, so the app
reports and waits, always. The risk percentages beside them stay capped at 100, and a test pins
that they do.

**A doc that taught the opposite.** `AUTOTRADE_RISK_SETTINGS.md`'s worked example added the
candidate's own $5,000 to reach the blocking total, four paragraphs above the sentence saying
"the candidate's own size never counts against itself here". The example is corrected; it is
how a reader (this one, for an hour) comes to believe the cap is about what a trade would add.

**The shipped defaults are below the floor too** — `maxSectorExposurePct` 20,
`maxCorrelatedExposurePct` 6 — and always have been, which is the un-fixed half of the
2026-08-27 finding CLAUDE.md records ("a percentage chosen as if it were risk"). Production was
hand-raised to 80 and the defaults never were. Left alone deliberately: changing a default
changes every account that has not overridden it, and that is a decision, not a cleanup.

## 2026-09-12 — the pace-scoring floor, re-fitted rather than guessed

**The question the flag waits on.** The section above established that pace scoring is not
cosmetic — ~15 symbols a tick newly pass against 0.3 newly failing. The spec's rule beside the
shadow then says `liveMinSignalScore` "has to be re-fitted against the pace-scored distribution
**before** the flag goes on". Nothing collected what a re-fit needs.

**And a re-score after the fact is impossible.** The pace component is `relVolume ÷ the universe
median this tick`. Neither term is persisted per symbol — `entry_components` stores the RAW
component on each trade, and the shadow row is an aggregate. So the pace-scored total of any
past entry cannot be reconstructed from anything the app has kept. Reaching for the mean shift
instead (72 + 2.2 = 74.2) would be a number with no basis: the lift is not uniform, it is
concentrated in the symbols that scored ZERO on the component under raw scoring (365 of 482 a
tick, falling to 244).

**What the screen already had in hand.** `runAutotradeScreen` computes BOTH scorings for every
scored symbol each tick and keeps `best` for each — the score of the better side, returned
precisely so a comparison can cover every symbol rather than only the survivors of the scoring
under examination. The distribution therefore costs a pair of counters, not a re-run.

**`SCORE_LADDER`** — 55, 60, 64, 66, 68, 70, 72, 74, 76, 78, 80, 85 — is counted both ways every
tick and journaled on the shadow row as `ladderRawAtOrAbove` / `ladderPaceAtOrAbove` over
`ladderScored`. Two-point resolution around the band any sane floor sits in (live 72, paper 60).

**`equivalentPaceFloor`** (edgeLeakScan.ts) reads it: the floor that preserves today's
selectivity is the pace rung admitting as many symbols as the live floor admits under raw
scoring, linearly interpolated between rungs at both ends of the translation. It returns null
off either end of the measured ladder rather than extrapolating, and the finding then says the
floor is "not yet measurable" rather than naming one.

The scan's `configuration:relvol_pace_scoring_shadow` finding now carries the answer directly:

```
THE RE-FIT: pace scoring admits as many symbols at a floor of <F> as the live
liveMinSignalScore of 72 admits under raw scoring, measured over <N> ticks of
the score ladder rather than inferred from the mean shift.
```

**Reading it, and what it still does not say.** The ladder answers the *distribution* half of
PR #44's original fit — the floor that admits the same set. It does not answer the *realized
edge* half, which needs closed trades at the new scoring and therefore cannot precede the flag
without the chicken-and-egg the shadow exists to avoid. That is the honest division: translate
the floor from the distribution now, then watch realized R against the pace score once the flag
is on. Enabling remains the operator's — the turnover widens the candidate set, which adds
exposure, so the lever stays `research` and the app never applies it.

## 2026-09-12 — the options ladder's gain side was capped at "double your money"

**The inconsistency, inside one feature.** Six fields govern the short-dated options exit
ladder, and five of them measure the same thing — **percent of premium GAINED**:

| field | unit | validator before |
|---|---|---|
| `optionsGiveBackArmPct` (40) | % of premium gained | `nonnegative()` |
| `optionsTakeProfitPct` (60) | % of premium gained | `.max(100)` |
| `optionsBreakevenTriggerPct` | % of premium gained | `.max(100)` |
| `optionsTrailStartPct` | % of premium gained | `.max(100)` |
| `optionsTrailStopPct` | percentage points of gain, behind the peak | `.max(100)` |
| `optionsPartialExitTriggerPct` | % of premium gained | `.max(100)` |
| `optionsStopLossPct` (40) | % of premium **lost** | `.max(100)` |
| `optionsPartialExitPct` | % of the **position** closed | `.max(100)` |

Percent-of-premium-gained is unbounded above — an option can be worth three times what you paid,
which is the entire reason the sleeve trades 0DTE contracts at all. `optionsGiveBackArmPct`
measures exactly that quantity and has always been `nonnegative()`. Its five siblings were
capped at 100, so **a take-profit could not be set above "double your money"**, a trail could
not start above it, and a partial exit could not be triggered above it — while the give-back on
the same ladder could arm at +150%.

This is not a judgement call about the right level: the loss-side fields are correctly capped
(you cannot lose more than the premium, or close more than the position you hold), which shows
the distinction was understood and then applied unevenly across one block of the schema.

**Not binding today, and said plainly.** Production runs take-profit 60 with the other four at
0, so nothing is currently refused by the ceiling. It is a latent ceiling on the direction the
evidence points: `OPTIONS_TUNING_PLAN`'s re-score found 40% and 30% take-profits read *worse*
than 60 (≈ +13% / +9% of premium against +17%), so the next move on this ladder is upward, and
100 is where it would have stopped.

**What shipped.** The five gain-side fields become `nonnegative()` at all three schemas that
carry them (the config route and both options backtest bodies) and `nonNeg()` in the sanitiser.
The loss-side and share-of-position fields stay capped, with a test pinning that they do — the
same shape as the concentration-cap change earlier the same day, and found by the same sweep:
*for every written bound, ask what range the quantity can actually take.*

## 2026-09-13 — the entry was sized at a price it had already stopped paying

The loop decided at one price and placed at another, and the gap landed on the
account as risk nobody approved.

`evaluateRiskCheck` sizes from `signal.entry` — the price the screener saw when
it picked the name. `placeOneLiveEntry` then runs: the idempotency guard, the
probation cut, and a **fresh quote**, from which it builds the marketable
limit. Between those two moments the batch has awaited a broker round-trip for
every candidate ahead of this one. Nothing revisited the quantity, and the
bracket's stop goes in at `signal.stop` either way — so the whole drift became
extra distance between the fill and the stop, on a share count sized for the
old distance.

It is one-sided, and the buffer is why. A marketable buy limit sits above the
quote and fills at or inside it, so a long's fill is never meaningfully below
the price the stop was hung from. Drift the other way costs nothing; drift this
way is unbudgeted.

**The record.** Every live row carrying `plannedStopDistancePct` (the
2026-09-11 forensics column, capture-only until now), realized stop distance
over planned:

| symbol | fill | stop | planned | realized | realized ÷ planned |
| --- | --- | --- | --- | --- | --- |
| MRNA | 147.61 | 143.91 | 2.50% | 2.51% | 1.003 |
| ACVA | 10.44 | 10.18 | 2.49% | 2.49% | 1.000 |
| HPQ | 34.96 | 34.08 | 2.49% | 2.52% | 1.011 |
| TNON | 9.42 | 9.17 | 2.45% | 2.65% | 1.083 |
| SWKS | 91.23 | 87.91 | 2.50% | 3.64% | **1.456** |
| DELL | 565.50 | 550.60 | 2.50% | 2.63% | 1.054 |
| MRNA | 144.86 | 141.06 | 2.50% | 2.62% | 1.049 |

Mean 1.094, median 1.049, and **not one below 1.000**. SWKS filled 1.19% above
the price its stop was anchored to: a trade sized for 2.5% of equity risked
3.64% of it. At the trial sizing that is most of a fourth of the daily halt on
one position, and three such positions carry 8.2% against a 7.5% aggregate cap
that believes it is holding the line.

**Three derivations of one quantity, and the main one disagreed.** The
scale-in add-on (`liveExecute.ts`) and the per-lot second lot both already
computed `|limitPrice − stop| × qty`. The entry path recorded
`approvedRiskAmount`, which is `|signal.entry − stop| × qty`. CLAUDE.md's rule
is that two places deriving one quantity agree by construction, so all three
now call `entryRisk.ts`'s `orderRiskAmount`.

**Which price risk is measured at.** Not the limit, and the distinction is the
difference between a fix and an over-correction. `guardrails.ts` values an
order's *notional* at its limit because that is what the broker reserves — a
limit order can consume every cent of its own limit. *Risk* is realized at the
**fill**, and this book's fills consume 0.05% of the 0.5% buffer
(`meanEntryBufferConsumedPct`, read 2026-09-12), so the fill lands essentially
at the quote. Sizing at the limit would have over-stated risk by most of the
buffer — at a 2.5% stop, a fifth of the position given away on every entry for
a fill that does not happen. `riskBasisPrice` names the choice so the two
prices stop looking interchangeable.

**What changed.** After the limit is built, the entry re-derives the quantity
against the placement quote and takes the **minimum** of that and the
risk-checked size. Never the maximum: a favourable drift would fund more
shares, but those shares never passed the guardrails and were never counted
against the aggregate budget, so sizing up would spend headroom nobody checked.
The order row, the batch's running risk total and `placedRiskUsd` all record
the risk the order really carries. `live_entry_risk_resized` journals both
prices, the drift, both quantities and what the unresized order would have
risked.

The budget takes the probation cut too. `approvedRiskAmount` is
`riskPerUnit × suggestedQuantity` *before* the multiplier is applied, so at 0.5×
it describes an order twice the size of the one being sent — a bound derived
from it would have been loose enough to pass a doubled risk. The same
overstatement is written down one sleeve over (`liveOptionsExecute.ts` scales it
explicitly) and one field over (`placedNotionalUsd`, fixed for the same reason
on an earlier pass). This is its third site.

**What did NOT change, and why it matters:** R. `initialRiskOf` already
measures the denominator from the **fill**, so the book's recorded edge was
never flattered by any of this — only the size was. Re-anchoring the stop or
the target to the fill would move exits, which is a trading decision, not a bug
fix, and it waits for the operator's word.

**The measurement.** The leak scan gains `execution:entry_drift`, fed from
`live_order_placed` (which now carries `signalEntry` and `riskBasisPrice`
beside `limitPrice` precisely so the question stays answerable after the fill
lands). The bar is the marketable-limit buffer itself: below it the drift is
smaller than the concession the loop already makes on purpose. The drift is
**signed**, positive for adverse on both sides, because a book that pays up 3%
half the time and saves 3% the other half is not a calm book and an unsigned
mean would read as one.

Separately, `fundableMaxQuantity`'s `boundBy` is finally read. It exists so a
shrunk order says which of the three ceilings shrank it, and all four messages
said "buying power" whatever the answer was — buying power is the broker's,
`order_notional` is `liveMaxOrderUsd`, `account_exposure` is
`liveMaxExposurePct`, and only the last two are within reach of a config
change. Naming the wrong one sent the operator at a dial that cannot move.

**What it costs, replayed on the seven rows that carry both prices.** Three are untouched
(the quote had drifted favourably or not at all, and the rule only sizes down); the median
keeps 99.4% of its shares; DELL 95%, MRNA 97%, HPQ 99%; and SWKS is cut to **66%**. Mean
94%, but the mean is one trade. The measured drift itself is mean **+0.19%**, median
**+0.014%**, worst **+1.26%** — so `execution:entry_drift` would NOT fire on this window
(the bar is the 0.5% buffer, and n=7 is under its minimum of 10 anyway), which is the
correct answer: the drift is a tail problem, not a book-wide one, and the rule is built to
cap the tail rather than to shave every entry.

This also separates two numbers that look alike. The 1.094 mean *inflation* above is
measured at the FILL and includes the ~0.05% of price the marketable buffer costs on every
fill — structural, and not something sizing can remove, since the stop is simply that much
further from a fill than from a quote. The rule removes the DRIFT component only.

**Pre-committed check on the next session:** the first `live_order_placed` row
carries `signalEntry` and `riskBasisPrice`; a session with any adverse drift
produces at least one `live_entry_risk_resized` whose `riskAtBasisUsd`
exceeds its `approvedRiskUsd`; and
`GET /api/journal/edge-leaks?sessions=40&book=live` reports
`execution:entry_drift` only if the mean adverse drift exceeds 0.5%.

## 2026-09-13 — the options entry, sized at a premium it had stopped paying

The equity fix above, one sleeve over, and the arithmetic is harsher here
because **premium is the risk**.

`optionsRiskCheck` sizes contracts from `signal.premium` — what the screener
saw — and both entry branches then re-fetch the contract quote before building
the limit (`fetchContractQuote` for a leg, two of them for a vertical). Nothing
revisited the contract count. A premium that rose in between is risk the budget
never approved, and premium moves faster on a 0DTE than any stock price does.

Worse than the equity case in one respect: `orderedRiskAmount` is not just a
transient. Its own comment says so — it "is STORED on the position and read for
its whole life by `getLiveOptionsPortfolioSnapshot` and `combinedLiveOpenRisk`"
— so a pre-drift figure understates the shared aggregate-risk budget for as
long as the position is open, blocking or admitting other entries on a number
that was never true.

**What changed.** `contractsWithinRiskBudget` and `optionsOrderRiskAmount` join
`optionsAffordability.ts`, which already owned the risk↔premium conversion, so
the size and the bound cannot disagree about how much of the premium is at
stake. Both branches call `resizeToFillPremium` once their fill premium is
known; it re-derives the contract count against that premium and takes the
**minimum**, then replaces `orderedRiskAmount` with the risk really carried.

**The max-loss fraction is named at the call site, not derived inside.** A
single leg risks `optionsDisasterStopPct` of its premium; a vertical's max loss
IS its net debit, so its fraction is a flat 1. Folding those together inside
the helper is how a spread would quietly get sized as though a 70% stop
protected it.

**Never below one contract when the check approved at least one.** A contract
is indivisible, and the floor is the same one probation already lives under.
Taking this to zero would convert a risk *overshoot* into a refused trade,
removing flow the plan is trying to add (Decision 3 widens this sleeve). The
overshoot is journaled instead — `live_options_entry_risk_resized` carries
`overBudgetAtFloor` — so an entry paying more than its budget is visible rather
than absorbed.

**It was not measurable, and now is.** `live_options_order_placed` recorded
`limitPrice` and `referencePrice` (the fill premium) but never the premium the
check sized against, so no journal read could compute the drift; the production
window holds exactly three placements and none of them can answer it. The row
now carries `signalPremium` beside `referencePrice`, the premium twin of the
equity path's `signalEntry` / `riskBasisPrice`.

**A fixture gap found on the way.** `liveOptionsExecute.test.ts`'s risk-check
context omitted `optionsDisasterStopPct`, which every real ctx builder passes
(`liveOptionsExecute`, `optionsExecute`, `optionsRiskCheck`'s own). The sizer
therefore failed safe to a 100% max-loss fraction inside the tests while
everything reading the config used 70% — two derivations of one quantity,
disagreeing only in the fixture. CLAUDE.md's rule is that a fixture gets every
field; this is why.

**Pre-committed check:** the next `live_options_order_placed` carries
`signalPremium`; an entry whose premium rose past its budget produces a
`live_options_entry_risk_resized` row, and one that rose past a single
contract's worth carries `overBudgetAtFloor: true`.

## 2026-09-13 — the scarcity gate the trial sizing put out of reach

`stagnationExitRequiresScarcity` is off, and its own comment pre-commits to
flipping it on "once ~2 weeks of paper closes are in". Before that happens, the
arithmetic underneath it has changed, and the switch would not do what the
evidence for it says.

That evidence — the stagnation exit's justification held in only **7 of 31**
firings — was measured at `riskPerTradePct` 1.25 and `liveMaxExposurePct` 155,
where three positions comfortably fit. At 2.5% and 190 they do not.

Notional per position is `riskPerTradePct ÷ stopDistance` of equity, the
sizer's own identity. At 2.5% risk over the recent median stop of 2.53%, one
position is **99% of equity**, so a 190% exposure cap funds **1.9** of them.
Three would need every stop at or beyond ~3.95%; 4 of the last 64 live entries
had a stop past 3.8%. So `slotScarcity`'s first branch — at
`maxConcurrentPositions` — is effectively unreachable.

Its second branch needs open risk above two full sizes. Two base-size positions
land exactly on its boundary, where the strict `>` correctly reports not scarce
(it is the exact complement of `riskCheck`'s `aggregateAfter <= aggregateCap`,
so the two agree by construction — verified). Position 2 is itself trimmed by
exposure headroom to ~90%, pushing further from the bar. It fires only when the
expectancy multiplier lifts them.

The rule is not wrong. What is wrong is the inference from its evidence:
flipping it on now would suppress the live book's **dominant exit** — 30 of 52
closes, 58% — far harder than 7-of-31 implies, leaving stagnant positions to
hold their slots until the end-of-day flatten, which is the slot starvation the
module exists to end. **The exposure cap, not `maxConcurrentPositions`, is what
"a slot" now means.** Recorded beside the rule so the flip is made with this in
hand rather than against a number from a different account size.

## 2026-09-13 — the give-back guard, armed by its first winner

Doubling `riskPerTradePct` halved every absolute day-level threshold in R, and
the give-back guard is where that bites.

The guard arms when the day's gain reaches `giveBackArmPct` and halts new
entries when an armed, unbanked day falls back to `giveBackFloorPct`. Both are
**thresholds, not windows** (`rawGainPct <= levels.floorPct`), so a move that
jumps the band still fires it — the guard works exactly as coded, at any
sizing. Verified before anything else, because "the guard is being skipped"
would have been the obvious wrong diagnosis.

What the sizing changes is *when it becomes live*:

| | old sizing (1.25%) | trial sizing (2.5%) |
| --- | --- | --- |
| goal 3% | 2.40R | **1.20R** |
| arm 2% | 1.60R | **0.80R** |
| floor 1% | 0.80R | **0.40R** |
| one 1R winner moves the day | 1.00R | 1.00R |

At 1.25% a single winner did not arm the guard. At 2.5% it does, without
banking (1.00R < 1.20R) — and the next 1R loser takes the day to 0.00R, past
the 0.40R floor. **Win one, lose one, and the session ends at roughly flat**,
while the guard is documented as protecting +1%.

**The band is deliberately not the trigger.** Arm-to-floor was 0.80R against a
1.00R step at the old sizing too, where the guard was doing its job, so a check
that fired on the band would have said nothing about the change. The regression
is the arm, and `giveBackArmedByOneTrade` triggers on `arm <= riskPerTradePct ×
targetRMultiple` — silent at 1.25% risk, which its test asserts explicitly.

**Reported, never applied, and with no proposed value.** Widening the band lets
the book keep trading on a fading day, which adds exposure and is the
operator's call. And there may be no coherent band to propose: inside a 1.20R
goal, any arm below the goal is cleared by one winner and any floor is jumped
by one loser. The real choices are to accept the guard as "stop once a winner
is given back", to switch it off and rely on the daily halt and the step-down
(neither of which depends on step size), or to move the goal — so the finding
states the arithmetic and stops.

`dailyGainStepPct` lives in `targetTune.ts` beside `concentrationCapFloorPct`,
which is the same disease one level down: a threshold chosen against one sizing
and left alone when the sizing moved.

**Timing.** No session has run at the trial sizing — Step 1 landed before
Monday's open and 2026-09-12 was a Saturday, so 09-14 is the first. This is a
finding made before it cost a day rather than after.

## 2026-09-13 — the gated-switch engine punished the operator for doing what it asked

A safe rule that proposed, was acted on, and correctly went quiet was recorded
as having contradicted itself — and barred from ever acting again.

The shadow record's contradiction test is `lastMet && !met && !applied`, and
`applied` means *the app* wrote the patch (`outcome === 'applied'`). During the
five-session shadow the app writes nothing by design, so the hand that applies
a proposal is the operator's — the plan's Workstream 5 says exactly that: "the
routine applies the safe-direction rules by hand on the operator's standing
authorization". The sequence that follows is:

1. The rule is met, is still shadowed, and journals `config_change_proposed`.
2. The operator applies the patch.
3. Next session the criterion no longer holds, and nothing was applied *by the
   app* — so `contradictions += 1`.
4. `graduationVerdict` blocks on `contradictions > 0`, the counter never decays
   (`nextSwitchState` only ever increments it), and the state is persisted in
   `gated_switch_state`.

The rule can never act on its own again, silently, for having been right.

**The code already had the principle.** Its own test is named "does NOT count
it when the patch was applied — the criterion lapsing is the fix working". It
simply asked the narrower question. `patchInForce(patch, config)` asks the
wider one: is every value in the patch already what the config says, by
anyone's hand? Compared with `Object.is`, so a `false` or a `0` counts as a
match rather than reading as absent — the whole of `overlay_revert`'s patch is
`{ mlRegimeEnabled: false }`.

Two of the four safe rules build their patch from data (the leak scan's lever,
the derived dollar caps), so the question cannot be answered against a rule's
literal. The shadow record now carries `lastProposedPatch`, persisted as JSON,
and a quiet session does not erase it — the next contradiction test is exactly
what it is being kept for. A stored patch that no longer parses is treated as
ABSENT rather than as `{}`, because `patchInForce({})` is false by design and a
corrupt row must not read as a settled one.

**What did not change:** a rule that proposes and then goes quiet with its patch
nowhere in force still records a contradiction and is still barred. That is the
gate's purpose — a rule reading noise — and a test asserts it survives, because
a fix that removed the gate instead of narrowing it would be worse than the bug.

**Exposure:** `overlay_revert`, `leak_lever` and `frozen_cap` can all propose
from session 1, inside the shadow window. `sizing_revert` was never exposed: it
cannot propose until 10 active sessions, by which point `evaluations` is past
the bar, so it graduates and applies on its first firing.

**Status when found:** latent. The engine had journaled nothing — no proposal,
no application, no graduation — and every rule was correctly quiet (the scan
reports 0 leaks, the caps are anchor-owned, the overlay's tripwires are
untripped, and the review has no sessions yet). Nothing had been lost; the trap
was simply waiting for the first safe rule to fire.

**Still open, and deliberately not decided here:** the single `contradictions >
0` test is applied to two different kinds of criteria — a statistical reading
that genuinely flaps (a mean day sitting near zero) and an event or state that
legitimately clears (a cap re-anchored, a leak falling under the bar, a windowed
count ageing out). Treating them identically is the "comparison whose two sides
are not the same kind of thing" class. Whether the gate should also forgive the
second kind is a judgement about how much autonomy the engine gets, and belongs
to the operator rather than to this fix.

## 2026-09-14 — which buying-power figure the sizer aimed at, on the row

First session at the trial sizing, 09:57 ET. BWIN was risk-checked, re-sized
118 → 117 by the placement-price rule, built, sent — and refused by the
**broker**: `live_entry_failed { reason: "Buying power is insufficient. Please
cancel open buy orders (if any) and try again." }`. COIN and NOW were both open
at the time.

That is the build-then-refuse loop `buyingPowerSizing.ts` exists to end — the
case that motivated it was 627 refusals and zero entries on 2026-08-28 —
happening again on day one of the new sizing. And there were **zero**
`live_buying_power_unavailable` rows, so the sizer had a figure. It simply
aimed at one the broker would not honour.

**The arithmetic, with the account's own number.** The account showed
**$13,822.77** of intraday buying power against **$3,522.74** of equity —
3.92×. `withDayBuyingPower` takes the broker's day figure whenever it is larger
(`liveDayBuyingPowerUsd` is 0, so uncapped), nets it against exposure, and
hands that to the sizer:

| | |
| --- | --- |
| deployed (COIN ≈ $3,323 + NOW ≈ $2,959) | $6,282 |
| the sizer's bound (13,822.77 − 6,282) | **$7,540** |
| BWIN's order (117 × 31.98) | $3,742 — fits, so it was sent |
| what the broker accepted against | smaller; it refused |

Whatever pool the broker checks when **accepting an opening order**, that
3.92× is not it. Its own message asks the account to *cancel open buy orders* —
committed capital counted against something smaller. `withDayBuyingPower`'s
written premise is about **holding** ("this caller is flat by the bell, so it
is entitled to the day figure"); the constraint that bit is about **opening**.
Those are not the same pool.

**What shipped here is the measurement, not a fix.** Nothing in the journal
said which figure had been used, so the entire paragraph above had to be
inferred from outside the app — including by reading the account balance by
hand. `buyingPowerBasis(state, cfg)` now returns the figure and its provenance
(`source: 'overnight' | 'day'`, the broker's overnight and day fields, the
`liveDayBuyingPowerUsd` ceiling when one applied, and the exposure it was
netted against), `withDayBuyingPower` is a one-line call to it so the sizer's
bound and the journal's number are ONE derivation, and both
`live_order_placed` and `live_entry_failed` carry it. A refusal now reads
"aimed at $7,540 from the day field, refused at $3,742 of order" on one row.

A tie stays `'overnight'` on purpose: the day field is only reported as having
won when it strictly raised the number, so a `'day'` row always means it moved
something.

**The lever that already exists**, once a session of rows says how wide the gap
runs: `liveDayBuyingPowerUsd` is a **cap, not a value** — 0 uses the broker's
figure in full, and a positive number refuses to use more than that however
much the broker offers. Setting it to the pool the broker actually honours
would make the sizer aim at the binding constraint. That number is not yet
known, which is exactly why this ships as instrumentation first.

Not the explanation: pattern-day-trader status. Webull no longer applies PDT to
this account and it may trade without a day-trade count, so the gap is about
which pool backs an opening order, not about a trade-count restriction.

## 2026-09-14 (second) — the cash balance, beside the margin figures

The instrumentation above answered "which buying-power figure did the sizer aim
at". The session then asked a question it could not answer.

**What the book did.** COIN exited 09:40, NOW exited 09:42 — flat. Then four
entries were refused by the broker, every one with *"Buying power is
insufficient. Please cancel open buy orders (if any) and try again."*: BWIN at
09:57, FTFT at 10:03, BWIN again at 10:11 and 10:17. The app blocked none of
them — zero live risk-check blocks, zero guardrail blocks — and there were no
open positions and no resting orders at the broker for any of them. The account
showed roughly $13.8–14.0k of buying power throughout, rising as positions
closed.

A $3,742 order refused against ~$13,800 with the book flat is not a margin
shortfall in any ordinary reading.

**The split that is in the data.** The two that filled were large caps (COIN
$186, NOW $138); the two refused were small caps (BWIN $32, FTFT sub-$1). That
is the shape of a purchase that needs CASH rather than margin — many brokers
margin small and low-priced names at 100%, or not at all. n=4, so it is a
hypothesis and is recorded as one.

**Why it could not be settled from the journal.** The captured Webull payload
carries three distinct figures — `day_buying_power`, `overnight_buying_power`
and `cash_balance` (plus the top-level `total_cash_balance`) — and
`withDayBuyingPower` bounds every order by the largest. Cash was parsed nowhere
and carried nowhere, so a cash shortfall and a margin shortfall produced
identical rows. Three separate explanations were advanced and discarded against
the operator's own readings before this became obvious: pattern-day-trader
status (Webull no longer applies it to this account), unsettled proceeds (the
figure rose rather than fell as positions closed), and a static entitlement
(it moved, $13,822.77 → $13,990.49).

**What changed.** `AccountState` gains `cashBalanceUsd`, mapped from
`asset.cash_balance` with the top-level `total_cash_balance` as a fallback, via
`numOrUndefined` so an unreported field stays undefined rather than becoming a
confident $0 — the same trap the file's own `firstNum` comment documents.
`BuyingPowerBasis` carries it onto `live_order_placed` and
`live_entry_failed`. Capture-only: no rule reads it to decide anything.

**The reading to take next.** On a refusal, compare the order's notional
against `buyingPower.cashBalanceUsd` rather than against `usedUsd`. If the
order exceeds cash while sitting well inside the day figure, the hypothesis
above is confirmed and the lever is the universe filter — `minPrice`, currently
**$1** — not a buying-power cap. If instead cash is ample, the hypothesis is
dead and the refusal is about something else again.

## 2026-09-14 (third) — the pool is spent by purchases, and the app learns the ceiling from the broker

The pre-committed reading above resolved on the first refusal after the
instrumentation deployed. **10:51:36 ET, BWIN:**

```
buyingPower: { usedUsd: 7095.29, source: "day",
               overnightUsd: 3658.24, brokerDayUsd: 10606.79,
               ceilingUsd: null, exposureUsd: 3511.50,
               cashBalanceUsd: 18.07 }
orderNotionalUsd: 3111.76   -> refused by the broker
```

**And the cash reading it confirmed turned out to be the wrong conclusion.**
The operator settled it against the account itself: margin is real here and had
been used that same morning. COIN (18 x $184.00 = $3,312.00) and NOW (21 x
$139.88 = $2,937.48) were held **together** — $6,249.48 against $3,497.62 of
cash, **1.79x**. A cash bound would have refused NOW outright, which is worse
than the bug. The small-cap reading in the section above was already dead
(CRWD filled at $3,479.55 while BWIN was refused at $3,720.12 the same minute);
the cash reading joins it. That is five wrong theories for one refusal — PDT
status, unsettled proceeds, a static entitlement, non-marginable small caps,
and a cash-only account.

**What the data does establish.** Every order that session, with the notionals
taken from the positions ledger rather than inferred from the journal:

| time (ET) | symbol | qty × price | notional | exposure then | result |
| --- | --- | --- | --- | --- | --- |
| 09:37:21 | COIN | 18 × $184.00 | $3,312.00 | $0 | filled |
| 09:37:24 | NOW | 21 × $139.88 | $2,937.48 | $0 | filled |
| 09:57–10:38 | BWIN ×4, FTFT | — | up to $3,720.12 | $0 | **refused** |
| 10:40:34 | CRWD | 15 × $231.97 | $3,479.55 | $0 | filled |
| 10:44:40 | BWIN | — | $3,076.80 | $3,483.45 | **refused** |
| 10:51:36 | BWIN | — | $3,111.76 | $3,511.50 | **refused** |

At **09:57 the book was FLAT** — COIN and NOW had both been sold — so
`exposureUsd` was back to 0 and the day branch handed the sizer the entire
$13,990.49. The broker refused $3,720.12.

**Closing a position returns the app's EXPOSURE to zero. It does not return the
broker's pool**, which is spent by purchases. So `brokerDay - exposureUsd` is an
upper bound the broker does not honour, and the two sides of that subtraction
are not the same kind of thing: a live mark-to-market value against a pool
debited at cost and not credited back on a sale. Fitting every row, the real
ceiling on CUMULATIVE purchases sat between **$9,729.03 and $9,969.60**, against
a reported `day_buying_power` of $13,990.49.

**Why no formula is written down.** Ten orders do not determine the broker's
rule, and each guess so far has cost a session. So the app does not model the
broker — it **remembers** it.

**What changed.**

- New `buyingPowerRefusals.ts` (a leaf module, in-memory, per account per ET
  day): the smallest opening notional the broker **refused** today and the
  largest it **accepted**. The ceiling is the midpoint — a bisection that
  converges in two or three attempts. With nothing accepted yet there is no
  lower bracket, so it steps 10% below the refusal instead.
- The clamp is applied to the **finished quantity** in `liveExecute`, after the
  probation multiplier, and journals `live_entry_ceiling_resized` with both
  brackets. Not to the buying-power figure: probation is applied after the
  sizer, so bounding the pool would halve an order that was already trimmed to
  fit and the book would walk itself down for no reason. `usedUsd` is dollars
  of POOL; the ceiling is dollars of ORDER NOTIONAL — different quantities
  judged at different points, which is why the basis only carries it.
- `buyingPowerBasis` moved to its own leaf module, and `tuneFunding.ts` now
  calls it instead of deriving the figure itself. The two disagreed on netting
  (the tune never subtracted exposure) and precedence (it took day over
  overnight unconditionally rather than the larger) — CLAUDE.md's "agree by
  construction".
- New `liveRefusalCeilingEnabled` (default **true**), on the Auto page beside
  the day-buying-power field.

**Why this is safe to leave on.** It is inert until the broker refuses
something, it only ever lowers, and it resets overnight. It cannot cost a fill
that was going to happen — it can only turn a refusal into a smaller order that
fills. On 2026-09-14 that is five entries the book never got.

**Also corrected here:** the note on `liveDayBuyingPowerUsd` is a *cap on the
day branch only* — `buyingPowerBasis` returns `max(overnightUsd, brokerDay -
exposure)`, so no value of it can bring the figure below the overnight one. It
was never the lever for this.

**The pre-committed check.** The next broker refusal should be followed by a
`live_entry_ceiling_resized` row on the following candidate, carrying
`refusedUsd` and a `toQuantity` below `fromQuantity` — and that order should be
ACCEPTED. If the smaller order is refused too, the row after it should show the
ceiling ratcheting down again. If refusals continue at every size, the ceiling
is not a notional at all and the mechanism should be switched off.

**What actually bounds trades per session (2026-09-14, measured).** Not buying
power. Of 96 signals, 65 were SHORTS and shorts are off (87
`live_short_skipped`); of the 11 long names, 10 fell under the
`liveMinSignalScore` floor of 72 (PSKY 71.7, BBY 69.8, IT 68.7, **CRWD 68.0 at
09:37:25**, HOOD 61.9, CRM 61.9, DFTX 61.3, PANW 60.8, WDAY 60.3, FTNT 60);
the three that traded were then locked out by the 390-minute re-entry cooldown
(107 skips). `live_risk_blocked` fired **zero** times all day. A further 120+
names were removed upstream by the 1.5x relative-volume pace floor (AMAT
1.42-1.48, BBY 1.20-1.29, BKR 1.13, ALB 1.06-1.10). CRWD was skipped at 09:37
and only cleared the floor at 10:40, after the move.

## 2026-09-14 (fourth) — raising the floor re-scored the shorts evidence

Enabling pace scoring came with `liveMinSignalScore` 72 → 81, the
exposure-neutral partner the shadow's own re-fit measured (pace-at-80.8 admits
as many symbols as raw-at-72). Within the hour the operator asked whether to
enable live shorts, and `GET /api/journal/short-shadow-record` answered:

```
journaledRows 165   n 1   avgR 0   winRatePct 0
excluded { below_live_floor: 164 }
gate { minTrades 30, minAvgR 0.1, minWinRatePct 50, passes false }
```

**164 of 165 declined shorts were excluded by a floor that had moved an hour
earlier.** The same rows counted at each bar:

| floor | eligible rows | sessions |
| --- | --- | --- |
| 72 | 32 | 2 |
| 76 | 19 | 2 |
| 78 | 6 | 2 |
| 81 | 1 | 1 |

`buildShortShadowRecord` filtered on `cfg.liveMinSignalScore` — the CURRENT
floor — applied to HISTORICAL scores. Two faults in one line. It re-scores its
own history every time the floor moves, and after this change it judged
**raw**-scored rows by a **pace**-calibrated floor, which is stricter than the
live book has ever been.

**The field to fix it was already on the row, and the write site says why.**
`live_short_skipped` carries `liveMinSignalScore` and `liveEligible`, and
`liveExecute.ts` states the contract where it writes them: *"the floor travels
with the row so a later change to `liveMinSignalScore` cannot silently rewrite
history."* Nothing read it. This is the "computed and never read" class one
layer below config — the value was journaled specifically to prevent this, and
the thing it was meant to prevent happened anyway, to the one instrument a
real-money direction decision depends on.

**What changed.** `SkippedShort` gains `floorAtSkip`, the route carries
`detail.liveMinSignalScore` through, and the filter uses the row's own floor,
falling back to current config only for rows written before the field existed.

**The decision it was asked for, recorded.** Shorts stay OFF. Even read at the
old floor the sample is 32 rows across **two sessions** with repeats (AMAT ×3,
KLAC ×2, VRT ×2) — nowhere near 30 independent trades, and the gate wants 30
with avg R ≥ +0.1 and a 50% win rate. The one short that did clear and replay
(VRT, score 81.1) exited at **0.00R on the breakeven ratchet after peaking at
+0.35R**, which is a fact about the book's exit geometry rather than about
direction: `liveScaleOutEnabled` is now false, so there is no partial to bank
on a winner that fades.

**The lesson, generalised.** When a report filters history by a threshold read
from live config, the report is not a record — it is a view that changes under
you. Any gate whose inputs are journaled must judge each row by the state in
force when the row was written, and the journal row has to carry that state.
Wherever a stamped field exists for this purpose, something must read it, or
the stamp is decoration.

## 2026-09-14 (fifth) — a blocked close cancelled the protection and left the position naked

The operator asked for an open BWIN position to be closed by hand. The first
attempt came back:

```
bracketCancelled: true
placed: false   reason: "blocked"
  order_notional:   $2,067.00 vs cap $500.00
  account_exposure: $2,077.40 vs cap $2,000.00
```

**The cancel succeeded and the replacement was refused**, so 65 shares sat at
the broker with no stop and no take-profit until the caps were widened by hand
and the close re-issued. Nothing re-armed the bracket and nothing alerted.

**Two faults, and the second is the one that made it inevitable.**

**1. Two OPENING caps were judging a CLOSING order.** `order_notional` and
`account_exposure` are limits on the risk an order may CREATE. A close creates
none — it realises risk already taken. `buying_power` had carried that
exemption since 2026-08-27 (*"n/a (closing frees buying power)"*); the other two
never got it. `account_exposure` was the worse of the pair: for a close it
compared the CURRENT exposure against the cap, so **the further over the cap you
were, the more firmly it refused the only action that fixes it**. That is
backwards for a risk limit.

It also could never be satisfied by construction. Autotrade's own per-order cap
is `liveMaxOrderUsd` **$5,284**, while the manual Trade page's is **$500** — so
every hand-close of an autotrade position was always going to exceed it. The
rule had been broken for the entire live book and stayed hidden because nobody
had hand-closed one before.

**2. The cancel ran before the guardrails had a say.** `closeLivePosition`
cancels the resting legs first, because the broker refuses a close as *"will
reverse an existing position"* while they rest. `placeOrder` then re-runs the
guardrails and can refuse — at which point the protection is already gone. The
file's own comment reasons correctly about the CONFIRMATION (*"an unconfirmed
request must have NO side effect at all"*) and that reasoning was simply never
extended to the guardrail verdict.

**What changed.**

- `guardrails.ts`: `order_notional` and `account_exposure` now exempt a close,
  reporting *"n/a (closing creates no new exposure)"* and *"n/a (closing reduces
  exposure)"*. Opening orders are judged exactly as before.
- `closePosition.ts`: `previewCloseGuardrails` dry-runs the same check BEFORE
  the cancel, from the same account read, the same `TradingConfig` and the same
  `withServerReference` (now exported rather than re-derived, so the preview and
  the real check cannot drift). A refusal skips the cancel only — it still falls
  through to `placeOrder`, which blocks again on its own fresh read and persists
  the rejected intent. Returning early would have protected the bracket and
  quietly stopped recording that a close was attempted, trading one invisible
  failure for another.
- A preview that cannot run returns null and the close proceeds as before:
  failing to evaluate must never be a reason to refuse, because refusing is what
  leaves a position stuck.

**What it does NOT fix, stated rather than papered over.** `placeOrder` re-checks
against its own fresh read, so a state change between the preview and the
placement can still refuse after the cancel. The window is now the width of one
account round-trip instead of the whole guardrail surface.

**The lesson.** Every one of these caps was written for an opening order and
then applied to everything. When a rule's justification is "this order creates
risk", the rule has a direction, and a check that ignores `openClose` is not
conservative — it is wrong in the direction that traps you in a position. The
one cap that got it right did so in 2026-08-27 for a reason it wrote down, and
nobody carried that reasoning across to its two neighbours.

## 2026-09-14 (sixth) — an entry whose price is being absorbed at a level

The operator spotted what the screener structurally cannot: BWIN scored **85.2**
— clearing even the raised 81 floor — while being, in their words, *"continuous
flat for several candles and not going to move"*. It was up on going-private
news, pinned at the buyout price. The journal agrees to the decimal:

```
09:57:06   $31.82   total 85.2   gap 8.27%   relVol 7.74
11:48:28   $31.95   total 85.2   gap 8.27%   relVol 9.88
```

Two hours, **thirteen cents**, and an identical score. Momentum, gap and trend
all read 100 — off the one-time deal gap, not off any ongoing move. The model
has no way to tell *"gapped 8% and still running"* from *"gapped 8% and died at
the deal price"*.

**Why the existing reachability gate misses it, by design.**
`risk_atr_unreachable_skipped` asks whether 1R fits this name's TYPICAL range,
reading a 14-day ATR:

```
ATR(14)            $1.133   (3.82% of price; recent daily ranges $0.83-$1.99)
stop distance      $0.741   = min(1.5 x ATR, 2.5% of price)
gate               0.741 > ATR x 0.7 = 0.793 ?  ->  PASSES, by 7%
today's range      $0.24    = 0.32x the stop distance
```

The ATR is propped up **by the gap day itself**. The same event that maxed the
score also inflated the yardstick the gate trusts, so both read the past and
both were fooled by the same candle. So the new gate asks the other question:
not what the name usually does, but what it is actually doing today.

**Why both conditions, and why neither alone.** A collapsed range is also
exactly what a coiled breakout looks like before it breaks; refusing those would
cost real trades. Volume separates them — heavy volume in a dead range is size
being absorbed at a fixed level, light volume is an ordinary coil still free to
expand. Across every name the loop looked at that session, BWIN was alone on
both axes:

| symbol | relVol | range / ATR |
| --- | --- | --- |
| **BWIN** | **9.88** | **0.21** |
| NOW | 1.84 | 0.68 |
| COIN | 1.20 | 0.81 |
| TER | 0.64 | 0.86 |
| VRT | 1.16 | 0.88 |
| CRWD | 1.42 | 1.68 |
| DFTX | 2.11 | 2.11 |

The next lowest ratio is more than three times BWIN's and the next highest
relVol is a fifth of it, so the defaults (**3x**, **0.5x**) sit in that gap
rather than on either edge of it.

**The elapsed-minutes guard (default 30) is not incidental.** Range accumulates
through the session, so every name looks collapsed at 09:31 — without it the
gate refuses the whole open, which is where the book's edge lives, and it would
have blocked COIN and NOW at 09:37. Before the guard expires the verdict is
`too_early`, never a block, and the ratio is still reported so an early row can
be fitted later.

**What changed.** `absorbedPrice.ts` (pure: `absorbed` / `free` / `too_early` /
`unmeasured`), three config fields (`absorbedPriceMinRelVolume`,
`absorbedPriceMaxRangeAtrFraction`, `absorbedPriceMinMinutesIntoSession`; either
threshold at 0 switches it off, the same idiom `maxRiskAtrFraction` uses), the
live gate journaling `absorbed_price_skipped`, `relVolume` carried onto
`TradeSignal`, and `minutesIntoSession()` on `marketHours`.

It **fails open** on any missing input: a provider hiccup that nulls the session
range must never read as "collapsed" and refuse every entry for as long as the
feed is unhappy.

**`relVolume` is NOT `relVolPace`, and the distinction is the gate.**
`relVolPace` is this symbol against the UNIVERSE this tick; `relVolume` is this
symbol against ITSELF. The question here is "heavy **for this name**", which only
the self-relative one answers — pace would call a quiet name heavy on a quiet
day.

**Live-only**, beside its ATR sibling, for the same written-down reason: paper
stays the always-on control track, so the filter can be judged against a book
that never had it.

**BWIN was also added to the exclusion list** with the measured reason, which
took effect on the next tick rather than waiting for this to deploy.

**The pre-committed reading.** The gate should fire rarely — one name in roughly
forty on the session it was built from. If `absorbed_price_skipped` starts
appearing on more than a couple of names a day, the thresholds are too loose and
the rows carry `relVolume` and `rangeAtrRatio` to re-fit them from. If it never
fires again, that is the expected outcome of a rule built for a specific,
uncommon shape — not evidence it is broken.


## 2026-09-14 — the entry-extension reading was dividing two different moments

`pctOfRange` was not a measurement yet, and the journal said so out loud. Five of
the first 43 live `entry_extension_shadow` rows put the entry price **outside**
the session range it was divided by:

```
                entry   session low   high    read
FCX   09-08 09:47   77.19    75.63    76.83   130.0%
FTFT  09-14 10:03    5.19     3.25     4.94   114.8%
SMCI  09-08 09:36   40.90    39.68    40.78   110.9%
BWIN  09-14 10:38   31.91    31.73    31.90   105.9%
CHYM  09-09 09:36   34.24    34.26    35.55    -1.6%   (below its own low)
```

The mechanism is the one PR #595 fixed one layer over, on risk sizing. The
numerator was `signal.entry` — the price the SCREEN saw, taken before a broker
round-trip for every candidate ahead of this one — and the denominator was
`sessionCtx.range`, built from 5-minute bars behind a 5-minute cache and fetched
AFTER the placement. Neither describes the moment the order was priced. Three of
the five land inside the first 20 minutes, where the range is small and one
missing bar is most of it: the signature of a lag, not of bad data.

**The visible rate is a floor, not the rate.** An error of the same size in the
other direction simply reads "lower in the range" and cannot be detected at all.
Only the tail that crosses 100 is observable.

**So no gate could be cut from the first bucket read**, and not because n was
small. FCX's entry sat 30 percentage points of range beyond its own high; bucket
edges at 50/70/85 do not survive noise of that size. The non-monotonic shape the
leak scan reported —

```
<50    n=10  -0.08R        70-85  n=5   -0.40R  CI [-0.80, -0.03]
50-70  n=5   -0.11R        85+    n=16  +0.18R  CI [ 0.02,  0.35]
```

— needs no real effect to explain it, and the reference rule (block above 60%
of range) would have removed a net +$99 and kept a net -$63.

Be precise about which part of the defect does that. **Dropping the five
impossible rows barely moves the buckets**: three map to a closed trade (FCX
+0.38R, SMCI 0.00R, CHYM +0.14R), and removing them takes 85+ from +0.180R to
+0.180R and `<50` from -0.08R to -0.10R. The visible errors did not produce the
shape. What undermines the cut is the part that cannot be seen: the range is
cached up to five minutes, so the dominant error is a denominator that is too
SMALL, which pushes a reading UP. The >100 rows are that error's extreme tail;
the rest of the tail reads as an ordinary number in a higher bucket than the
trade belongs to. Directional, up to 30 percentage points of range, and
observable only at its extreme.

### What changed

1. **The price is the one the order was really priced at.** The live path passes
   `riskBasisPrice(last)`, the placement quote the sizer already risks against;
   the paper path passes its fill. Two derivations of one quantity agree by
   construction or they disagree in production.
2. **`rangeIncluding` widens the range to contain that price before dividing.**
   A price that just printed in this session IS part of the session's range; a
   range that does not contain it is simply behind. `0 <= pctOfRange <= 100` is
   now a property of the function rather than a hope about its inputs, and "at a
   new high of day" reads 100 with `extendedRange: 'above'` beside it instead of
   an impossible 130.
3. **The residual is counted, not assumed away.** The bars can still be one bar
   plus one cache TTL behind, so a high printed above our own quote is invisible.
   That biases a reading DOWN, where the old defect was two-sided and unbounded.
   `extendedRange` counts how often the quote fell outside the bars at all.

### The dimension could never have been confirmed either

The scan will not call a bucket a leak unless the paper control's same bucket
agrees in sign. The shadow was journaled on the **live entry path only**, so
`attributesForPaperBook` filled `pctOfRange: null` for every paper row — the
control did not exist and never would have, however many trades accumulated. It
read "unconfirmed" for a structural reason wearing a statistical one's clothes.

`execute.ts` now journals the same action for the paper book, measured at the
paper fill. Both books enter the same symbol in the same tick and therefore the
same minute, and the scan joins on symbol + minute, so the rows carry a `book`
field and the index is keyed by it — without that the live row overwrites the
paper one and the control becomes a copy of its own subject. Rows written before
today carry no `book` and default to `live`, which is what they were.

### Known-bad readings are dropped and COUNTED

A `pctOfRange` outside 0..100 is a known-bad measurement, not an extreme one.
Clamping it to 100 would invent a reading the data does not support; bucketing it
puts a trade in a band chosen by measurement error. The attribute is dropped —
the trade stays in every other dimension — and the scan's coverage carries
`extensionQuality { measured, staleBars, unusable }`, because a report that
silently discards 12% of its input is the failure this codebase keeps repeating.

The tune advisor reads it: while `unusable > 0` in the window, a `pctOfRange` or
`vwapExtension` leak is reported as `needs_data` rather than ranked as a cut,
the same downgrade a truncated skip read already applies to `no_live_row`.

### The pre-committed reading

No new row can read outside 0..100, so `extensionQuality.unusable` falls to zero
as the pre-fix rows age out of the 40-session window — at which point the
extension dimension becomes rankable for the first time, with a real paper
control beside it. `staleBars` is the number to watch meanwhile: if most
readings are taken while the bars are behind, the 5-minute fetch is too coarse
for this measurement and the next step is a finer bar, not a finer cut.

## 2026-09-14 — every refused entry is journaled; none of them could be SCORED

Task #45 audited the live entry path and found no gate silent: every refusal
writes a row. What nothing asked is whether those rows can be **replayed**, and
none of them could. Each carried the reason and the numbers the rule itself
reasoned about — and not the entry price, the stop or the side, which are the
three a replay needs. `live_short_skipped` was the lone exception, which is the
only reason the short shadow record exists at all.

So the largest refusal class on the entry path was unmeasurable:

```
risk_atr_unreachable_skipped   80 symbol-days over 8 sessions (09-02..09-14)
                               16 on 09-14 alone, against FOUR entries placed
```

### The gate is a universe filter, not a setup filter

It refuses when 1R costs more than `maxRiskAtrFraction` of the name's daily ATR
— sound in isolation. Composed with the stop derivation it is something else.
The stop is `min(stopAtrMultiple × ATR, maxStopDistancePct% × price)`, so at
1.5 / 2.5% / 0.7 the ATR term can **never** pass (1.5 > 0.7) and the percentage
clamp must bind, leaving one admission rule:

```
admitted  <=>  ATR >= maxStopDistancePct / maxRiskAtrFraction  =  2.5 / 0.7  =  3.57% of price
```

Every live entry confirms it: COIN, NOW, CRWD and BWIN on 09-14 all placed with
a stop at exactly 2.50% of entry. And the refusals are the liquid large-cap
universe, by construction rather than by any judgement about those setups:

```
GOOGL 1.06   MSFT 1.19   META 0.77   IBM 0.86   NFLX 0.92   XOM 1.19
EOG 1.08     MDT 1.03    MPC 0.89    KR 0.98    DVN 1.06    OXY 1.08
VZ 1.38      ACN 0.72    APA 0.79    DV 1.50
```

Loosening to 0.9 would admit 52% of the 80; to 1.0, 62%. **No such change is
being made here** — the point of this entry is that there was no basis for
making one either way.

### Paper was not the control it was believed to be

The gate was moved live-only on 2026-09-01 expressly so paper would be the
control group ("left the experiment measuring it with no control group"). Over
the same eight sessions exactly **two** closed paper trades land on a symbol-day
the gate refused, both ROIV on 09-08 (−0.24R, 0.00R). Paper's three slots fill
early on the same high-ATR names, so it almost never reaches the ones the gate
turns away. A control arm producing two trades in eight sessions is not a
control arm — the same discovery the entry-extension dimension made on the same
day, wearing different clothes.

### What changed

`journalDeclinedEntry` (declinedEntry.ts) replaces `journalEntrySkipOncePerDay`
on every entry-path gate and stamps, by construction:

- `entry` / `stop` / `side` — a replay's inputs. 1R is `|entry − stop|`; without
  the pair the row can be counted and never scored.
- `liveMinSignalScore` and `liveEligible` — the floor **in force at the
  refusal**. Several of these gates run BEFORE the score floor, so their rows
  include candidates the book would have declined anyway, and a reader filtering
  by TODAY's floor silently re-scores its own history every time the floor moves
  (raising it 72 → 81 cut the short record's eligible rows from 32 to 1). The
  fix was `floorAtSkip`; stamping it here makes it impossible to forget on the
  next gate someone writes.

The caller's own detail is merged **first**, so a rule's own key can never
shadow a replay field — several gates journaled their own `score`, and the two
have drifted apart before.

A source-scan test (`declinedEntry.test.ts`) fails if any bare
`journalEntrySkipOncePerDay` call returns to `liveExecute.ts`, and a second one
pins the every-tick re-entry row, which keeps its own writer and would otherwise
drift out of the rule unnoticed.

### And something reads it

`declinedEntryShadow.ts` is the short shadow's replay with the SHORT taken out:
one derivation, shared, rather than a second copy that agrees on the day it is
written and not for long. `shortShadowRecord.ts` is now that replay plus task
#21's enabling gate. `GET /api/journal/declined-entry-shadow?action=&since=`
points it at any refusal class.

`unscorableRows` is on the response on purpose. Every row written before today
is unscorable, so a reading taken now is mostly holes — and a report that hides
its holes reads like a verdict.

**The floor filter has a carve-out, and it is load-bearing.** Rows are dropped
when they sit below the floor that judged them, because most of these gates run
BEFORE the score floor and their rows include candidates the book would have
declined anyway. For the floor's OWN refusals that is exactly backwards: those
rows are below the floor by definition, so the filter deletes the evidence and
the replay returns empty — which reads as "no signal" when it means "wrong
question asked". `SCORE_FLOOR_ACTIONS` names the three
(`live_score_floor_skipped`, `finish_line_skipped`,
`regime_score_floor_skipped`) and the route turns the filter off for them. The
last two are the subtle ones: their rows sit ABOVE the everyday floor and were
refused by a stricter bar, so the filter would pass them and quietly measure
only part of what each rule costs.

### The pre-committed reading

`risk_atr_unreachable_skipped` accrues ~10 rows a session. At 30 scorable
symbol-days, read the shadow. If the refused names average **below** 0R the gate
is earning its flow cost and stays at 0.7. If they average at or above the live
book's own mean R with a 95% interval clearing zero, the gate is refusing trades
that work, and the lever is `maxRiskAtrFraction` — an **exposure** change, so it
waits for the operator under Workstream 7's table, with the replay's three
caveats (not a P&L, not a fill, resolves ambiguity against the trade) quoted
beside the number.

## 2026-09-14 — Recent activity splits by book

Asked for immediately after the slot confusion above, and for the same reason:
the journal is one stream, the two books write into it at wildly different
rates, and nothing on screen separated them. On 2026-09-14 the paper book wrote
**4,983** risk-check refusals against **four** live entries, so the live book's
whole day was invisible under the noise.

`eventBook.ts` decides which book a row describes, `GET /api/autotrade/events`
takes `?book=live|paper|shared` and returns the decision on every row, and the
Auto page gets four tabs with per-book counts plus a badge per row.

### It is not a name check, and that is the whole difficulty

Of the 159 actions the loop can write, **86 carry neither prefix**, and they do
not split the way the names suggest:

```
liveExecute.ts      risk_atr_unreachable_skipped, absorbed_price_skipped,
                    entry_filled, exit_filled, level_veto, per_lot_*,
                    entry_window_closed, equity_synced          -> LIVE
optionsExecute.ts   options_paper_*                             -> PAPER
liveOptionsExecute  finish_line_skipped, symbol_cooldown_skipped,
                    options_probation_at_minimum                -> LIVE
```

A `startsWith` filter would have put dozens of live rows under Paper and vice
versa — a worse failure than the ambiguity it set out to fix. **An unlabelled
row makes you look it up; a mislabelled one makes you sure.**

The rule, in order: an explicit `book` in the detail wins (the only thing that
can separate `blocked`/`passed` and `entry_extension_shadow`, which BOTH books
write); then the prefix; then an explicit table; then `shared`.

### The guard found a real error in the first draft

`eventBook.test.ts` re-derives each action's book from the **module that writes
it** and asserts the classifier agrees. On its first run it failed on three
actions — `short_dated_entry_window_closed`, `short_dated_options_exit`,
`short_dated_position_already_open` — which were in `PAPER_ACTIONS` because
`optionsExecute.ts` writes them. So does `liveOptionsExecute.ts`. Every LIVE
options cutoff, exit and slot refusal would have been filed under Paper.

They carry `book` now (two of the three live writers were missing it; the paper
twins already had it) and resolve from the detail. With no stamp they read
`shared`, which is the honest answer for a row whose book cannot be recovered —
not a guess at the likelier sleeve.

The guard also caught its own scanner: a tightened version that only read text
near a `logAutotradeEvent(` call silently missed `entry_filled` and
`exit_filled`, whose object literals are long. A scan that under-reads is the
dangerous direction — it vouches for a table with a hole in it — so the loose
scan stayed and its three false positives (`skip`, `hold`, `reanchor`, all
discriminants of `ReanchorDecision`) are named explicitly.

### The filter must run server-side, and say how deep it looked

Filtering the newest page client-side would return an empty Live tab on a
normal day. So `?book=` scans up to `ROW_CAP` rows, classifies with the one
classifier, and returns `bookCounts`, `scannedRows` and `scanTruncated`. An
empty list with `scanTruncated` true means "not in the last 1,000 rows", never
"none happened", and the empty state says which — the same rule as
`unscorableRows` and `journalSkipsTruncated` elsewhere in this file.

The book rides on each returned row rather than being re-derived in the web: two
copies of this classification would agree the day they were written and not for
long, and this one has already been wrong once.

## 2026-09-14 — the real-estate bans are visible, and a hand exclusion stops reading as a REIT

Two separate checks enforce the real-estate exclusion (screen.ts): the
hand-maintained list, and the sector/industry classifier. The Auto page only
ever showed the **first**. On 2026-09-14, of the 32 symbols refused:

```
29  sector classifier   AMT ARE AVB BXP CBRE CCI CPT CSGP DLR DOC EQIX EQR
                        ESS EXR FRT HST INVH IRM KIM MAA O PLD PSA REG ...
 3  hand list           BWIN among them
```

Twenty-nine bans existed nowhere but `excluded_re` journal rows, one per symbol
per ET day, and only for names a screen happened to reach.

### The standing list is a read of two tables, not of the journal

`listRealEstateBans()` answers "what is banned right now" from the universe
table and `autotrade_sector_cache`, with no network. **Both stores are
required**, and the reason is easy to miss: `classifySector` returns EARLY on a
universe sector hit and never writes the cache, so a cache-only read would have
missed all 29 of the above — every one of which was universe-sourced. Its test
proves that premise rather than assuming it, by classifying a universe symbol
and asserting the cache stays empty.

`isRealEstateSector` is now shared by the live classification and the standing
list, so the screen's decision and the page's audit of it cannot disagree about
what counts.

### A hand exclusion was being recorded as a real-estate ban

`screen.ts` called `isExcluded(symbol)` and journaled a hardcoded
`'On the real-estate exclusion list'`, discarding the reason stored on the row.
The list is named for real estate and **is not real-estate-only in practice**:
BWIN was added that morning for being a going-private buyout that had stopped
moving, and was recorded — and displayed — as a REIT.

The branch reads the row now (`getExclusion`) and journals the operator's own
words plus `check: 'exclusion_list'`; the classifier branch carries
`check: 'sector_classifier'`. The ACTION stays `excluded_re` for both: renaming
it would make every existing reader of this book's history wrong in order to fix
a label, which is the same trade the risk-check `book` field declined earlier
the same day.

A record that says the wrong thing is worse than one that says little.

## 2026-09-14 — the day is the LOOP's P&L, not the account's

Reported by the operator: "the auto trading stopped since the beginning of the
afternoon." It had, and the reason was that the loop banked its day on money it
had not made.

`evaluateDailyTarget` measured `(accountEquityUsd − baseline) / baseline` — the
whole brokerage account, synced from the broker every tick, carrying the
operator's own manual trading and the UNREALIZED P&L of their open positions.

The session, to the dollar:

```
baseline                                    3,522.81
loop's realized closes    CRWD +82.35, COIN +35.46,
                          NOW +0.63, BWIN −0.65      +117.79   (+3.34%)
operator's realized closes                            −34.60   (−0.98%)
                                          both       +83.19    (+2.36%)  <- under the 3% line
manual TSLA options, ~14:40                          ~+88
account crosses 3% and banks the day     14:41:01 ET
```

Every tick afterwards refused 26–28 live candidates with `live_entries_halted`.
Realized trading alone never reached 3%; the manual options position is what
banked it.

The unrealized half is the sharper edge: an open manual position merely UP ON
PAPER banks the loop's day, and can then give it back, leaving the book halted
for a gain that never existed. The same number drove the give-back guard, so a
manual LOSS could halt the book just as easily.

### What it measures now

The loop's own realized P&L — `strategyDayFor`, live stock plus live options,
the exact figure the results calendar already reported and independent of every
equity reading. One derivation serves the live control and the calendar.

Two quantities that were being confused for each other now have one name each:
`gainPct` is what the loop did, `accountGainPct` and `currentEquityUsd` stay on
the status as what the operator feels, and decide nothing.

The daily DRAWDOWN halt needed no change — `getLivePortfolioSnapshot`'s
`dailyPnl` already counts autotrade-tagged closes only. It was the goal and the
give-back guard that read the account.

Realized, not marked-to-market, matching the halt's own long-standing
convention: an open winner does not bank the day, for the same reason the halt
lets open positions carry a loss a little past it.

### What this changes about the trial

The loop will trade later into a session than it did, because a green account no
longer stands it down. That is an exposure increase and was the operator's
explicit call. It also cuts the other way: a red afternoon in the operator's own
account can no longer halt a book that is quietly up.

The 2026-08-27 two-tick confirmation stays. Its original failure — a spurious
net-liquidation reading banking the day at a fictional +9.69% — is now
impossible twice over, but the confirmation still guards a spurious P&L (a
mis-booked exit, a reconcile that double-counts), so its tests spike the thing
that decides now rather than the thing that used to.

### Three other rules were measuring the same day on the account

Moving the halt is not the change; moving it while three other rules keep their
own derivations is how CLAUDE.md's 2026-08-27 disease reproduces. Every place
that asks "how far is the day from a day-level line" now READS one field off the
status instead of subtracting its own pair of equities:

| rule | it used to compute | it now reads | what disagreed |
|---|---|---|---|
| finish-line trim (`computeFinishLineFactor`) | `targetEquityUsd − currentEquityUsd` | `gapToTargetUsd` | on 2026-09-14 the account sat $66 PAST a line the loop was $105 short of, so the trim read "already banked" and would have sized the closing trade at full risk on a day that had not been earned |
| day-protective stop (`dayProtectiveStop`) | `currentEquityUsd − floorEquity` | `headroomToFloorUsd` | it sets a REAL stop on a REAL position from that distance, so an afternoon of hand trading moved where the stop went |
| the review's goal rate (`buildSizingReview`) | the stamped `goalReached`, minus every manual-trading session | the stamp, with the exclusion applied per row | see below |

`evaluateDailyTarget` owns `targetPnlUsd`, `gapToTargetUsd` and
`headroomToFloorUsd`, all in dollars of the loop's own realized P&L against the
same baseline. Two derivations that agree today are not the goal; one
derivation is.

### The review's goal rate, and a column instead of a workaround

`goalReached` was stamped when ACCOUNT equity crossed the target, so the review
compensated by dropping every manual-trading session from the goal rate — which
is the same charge its own notes lay against a threshold: it throws away real
sessions out of a window only ten sessions long, and `manualTrading` fires on
clean days too (options are deliberately not flattened at the close, so an open
contract's mark can cross 0.5% on its own).

A row now records WHICH quantity stamped it (`autotrade_daily_results.goal_basis`:
`strategy`, `account`, or null for a row written before the column or
backfilled). A `strategy` row cannot carry that contamination and is counted
whatever the divergence flag says; a null row keeps the old exclusion, because
for it the old charge is still true. Same construction as `risk_per_trade_pct`
before it: no date literal decides anything, and the exclusion retires itself
once the window holds no pre-change rows.

### And the batch refusals name what they refused

`live_entries_halted` and `entry_window_closed` refuse a whole tick before any
candidate is examined, so they carry no `symbol` and Recent activity showed a
dash — which is how this was reported in the first place. Both now carry the
symbols. A count cannot answer "what did I miss while the book was stood down",
which is the only question those rows are ever read for.

## 2026-09-14 — four sizing lines were each claiming the whole product

Found while reading a production `live_risk_blocked` row from 2026-09-11 to
understand a 3-share order. The same journal entry said:

```
step_down_sizing     active — 4 consecutive losses, sizing at
                     0.36540000000000006% instead of 1.25% (50% cut)
repeat_entry_sizing  active — 1 prior exit(s) in this name today, sizing at
                     0.36540000000000006% instead of 1.25% (40% cut)
```

Two lines claiming the same move for two different reasons, and **neither cut
produces it**: 50% of 1.25 is 0.625, the 40% cut gives 0.75. 0.3654 is the
product of five factors (step-down ×0.50, repeat-entry ×0.60, expectancy ×1.12,
method ×0.87) — and no line in the row reported it as a product. There was no
line for the effective risk at all. The raw float went out as text, too.

Both risk checks built `sizing at ${effectiveRiskPct}% instead of
${ctx.riskPerTradePct}%` **once** and appended it to four different factor
lines. It is CLAUDE.md's sibling-value mistake living in the record rather than
in the arithmetic: one computed value, presented as four different ones. The
sizing itself was correct throughout; what was wrong was the only line an
operator reads to understand a small order — and it matters more at the trial's
2.5%, where a compounded cut to 0.73% is exactly what someone would go looking
for.

**Now:** each factor line states only its own effect (every one already named
its cut or its multiplier), and one new `effective_risk` check reports the
product with the terms that made it:

```
effective_risk  0.37% of the configured 1.25% — step-down ×0.50,
                repeat-entry ×0.60, expectancy ×1.12, method ×0.87 (net ×0.29)
```

Factors at exactly 1 are left out, so the two that did something are not buried
under five that did not; when none moved, the line says so rather than printing
an empty list. Both books call one describer in `effectiveRisk.ts`, for the
reason the product itself lives there: the two copies of that product are what
drifted in the first place. `effectiveRisk.test.ts` scans both sources and
fails if any factor line interpolates the final percentage again — the
per-line tests pin today's wording, the scan pins the shape.

Reporting only. No sizing changed.

## 2026-09-14 (same evening) — the goal basis belongs to the STAMP, not to the recorder

The `goal_basis` column added hours earlier got its very first row wrong, which
is the most useful kind of bug to find: the column exists precisely to keep an
account-banked day out of the strategy goal rate, and its first row was an
account-banked day labelled `strategy`.

What happened on 2026-09-14, in order:

1. 14:41:01 ET — the ACCOUNT crossed 3% (+4.87%, carried by a manual TSLA
   options position) and the then-deployed evaluator stamped `reached_at`.
2. ~16:30 ET — the loop's-own-P&L change deployed.
3. 16:45 ET — the results recorder ran and wrote the row.

`recordDailyResult` set `goalBasis: current ? 'strategy' : …` — "if this is
today's baseline row, the basis is strategy". That asserts the basis of the code
RUNNING NOW, and a recorder runs after the fact. The row read `goalReached:
true`, `goalBasis: 'strategy'`, `strategyGainPct: 2.01` — a strategy-basis goal
day at two-thirds of a 3% goal, which the review would have counted.

(The loop's own day, for the record: +$117.79 on the stock sleeve, −$47.00 on
the live options sleeve — two INTC 09/14 puts stopped out — so **+$70.79,
+2.01%**. It never reached 3%. The account's +4.87% did.)

**The basis is now stamped with the reach**, on `autotrade_daily_baseline.
goal_basis`, written in the same UPDATE as `reached_at` by
`markDailyTargetReached(now, 'strategy')`. A basis written beside the thing it
describes cannot disagree with it; one inferred later always can. The recorder
reads the stamp instead of asserting one.

2026-09-14's own row carries NULL — the column did not exist when its reach was
stamped — and null reads as "the old, account-derived basis" everywhere
downstream, so the review excludes it as a manual-trading day. That is the right
answer for that day, reached without a date literal anywhere.

The general rule, which is the 2026-08-27 disease in the time dimension: **when
a fact and its provenance are written at different moments, the provenance is a
guess.** Write them together.

## 2026-09-15 — a stop cannot be placed where the market has already been

> **Corrected 2026-09-23.** BWIN was not through its stop. At 12:13 it traded
> at 31.95 against the 31.16 stop, and the broker's refusal (*"…should be higher
> than the current market price"*) was its rule for a **buy** stop: the re-arm
> was sending its legs on the wrong side. The rule below is still right for the
> case it describes, and with the side fixed, a refused re-arm is finally a sell
> stop the market has passed. The kill-switch paragraph below was also only
> half true: the close was stopped, the re-arm above it was not. See
> "2026-09-23 — the protective re-arm sent buy orders, and the kill switch never
> reached it".

PR A's equity half committed to "a standalone protective bracket at the recorded
stop (**or a marketable close if price is already through it**)". Only the first
half was built, and the second half is the one that matters, because the first
half *cannot* work in the case it describes.

2026-09-14, BWIN, 12:13 ET: the position was confirmed naked (65 shares held at
the broker, zero resting exit legs), the automatic re-arm fired, and the broker
refused it — *"The stop price of the stop-loss order should be higher than the
current market price."* Price was already through the recorded 31.16 stop. The
sweep's entire response was `live_position_unprotected`, a page. The position
stayed naked through the afternoon, past the stop that was the decision, and
closed at −$0.65 on luck rather than design. At 2.5% risk, where one position is
most of the account's notional, that is the largest uncontrolled exposure the
system has.

### Three independent facts, all required

This is the only branch of the protection sweep that sells real shares with no
human in the loop, so the gate is deliberately narrow:

1. the broker confirms the shares are still held — the same read that tells a
   naked position from a stop mid-fill (the SMCI case of 2026-09-08);
2. the re-arm was **attempted and explicitly refused** — an *unanswered* one
   (timeout, 429, 5xx) does not count: that bracket may well be resting with a
   combo id nobody learned, and closing over it is two sells against one
   position, which for a long means an oversell that flips it short. It is the
   same reason the re-arm itself never retries an ambiguous placement;
3. a quote **fetched at that moment** is through the recorded stop (at or below
   for a long, at or above for a short — equality counts, since a stop resting
   exactly at the market is what the broker refuses).

(2) and (3) are separate sources that must agree. Acting on the broker's wording
alone was the tempting shortcut and is exactly the kind of string dependency
that breaks silently the day a vendor rewords an error; acting on the quote
alone would close positions whose stop was merely unplaceable for some other
reason.

### What places the order

`placeLiveEquityTimeExitClose`, unchanged — the same path the stagnation and
end-of-day exits use. That reuse is the design, not a convenience: it cancels
the resting legs first, prices a **marketable limit at the 0.5% buffer** rather
than sending a market order, runs the full guardrails, and already handles the
ambiguous-placement case that stops a second close going out against a position
whose first may have filled. A new trigger kind, `unprotected_breach`, carries
the recorded stop, the price read, the held quantity and the broker's re-arm
refusal into the one `live_time_exit_placed` row the sequence produces.

A double close is ruled out by the DB-backed pending-exit set rather than an
in-memory latch — a restart must not be able to sell the same shares twice,
which for a long means flipping short.

### What it deliberately does not do

- No quote, no action: without the third fact it pages, as before.
- Unanswered re-arm: pages. See fact (2).
- Price not through the stop: the position needs its stop back, not an exit.
- Re-arm succeeded: a stop the broker accepted is protection.
- **Kill switch engaged: no close.** The sweep still RUNS under the kill switch,
  because a halted account still needs to know a position is naked, but the
  close goes through the shared guardrails and fails `kill_switch`. Detection is
  free and always on; placement is not. That split is the operator's one lever
  over a path that otherwise acts without them, and it is pinned by a test.
- A close that fails still pages, carrying `breachCloseFailed` — the position
  really is unprotected.

### And a header that had stopped being true

The sweep's own doc comment still read *"Read-only: … it places, cancels and
modifies nothing"* three days after the re-arm made it place a bracket. That is
the comment class CLAUDE.md's own notes warn about — an assertion of a property
the code no longer has, which is what stops the next reader looking. Rewritten
to say what it now does and, more usefully, where the kill switch sits in it.

## 2026-09-15 — the give-back guard is off, because the band is narrower than one trade

Applied to production on the operator's word: `giveBackArmPct` 2 → null,
`giveBackFloorPct` 1 → null. The goal stays at 3%.

**The arithmetic.** At 2.5% risk with a 1R target, one trade moves the day ±2.5
points. The band from arm (+2%) to floor (+1%) is one point wide. So:

```
win  +2.5%  -> arms the guard (2%), does not bank (3%)
lose -2.5%  -> day at 0%, below the 1% floor -> guard fires, entries halted
```

In R: the goal is 1.2R tall, the arm sits at 0.8R, the floor at 0.4R, the step
is 1.00R. **No valid band exists** — the route requires floor ≥ 0 and arm <
goal, and every band inside a 1.2R-tall day is crossed by a 1R step. The guard
is either hair-trigger (as configured) or inert (arm just under the goal).

**The cost, measured.** Live record: 75 trades over 12 sessions, 47% win rate,
median 6 trades a session. Win-then-loss opened **2 of 10** sessions, and the
sessions it truncates are the busiest ones (12, 11, 11, 9 trades). That attacks
the FLOW term of `trades/session × risk% × edge R`, which is the term the 3%
goal leans on hardest.

**This is a defect the 2026-09-12 change set introduced, not a rule that was
always wrong.** Under the pre-trial config the same 2/1 band was coherent:

| | winner | loser | win-then-lose | fires? |
|---|---|---|---|---|
| before (1.25% risk, 2R target) | +2.5% | −1.25% | +1.25%, above the floor | no — took win-lose-lose |
| after (2.5% risk, 1R target) | +2.5% | −2.5% | 0%, below the floor | **yes, after two trades** |

Two changes compounded: risk doubled *and* the target halved, so the loser became
the same size as the winner and both became large against a one-point band. The
plan said "the daily target 3 / 2 / 1 stays" without noticing that halving the
goal's height in R makes the band narrower than a trade.

**What is lost, and why it is little.** At a 1.2R goal the guard was nearly
redundant with the bank halt: the day banks at 1.2R, only 0.2R above where a
single winner lands, so the window the guard polices is 0.2R wide. At the old
2.4R goal that window was over a full trade wide, which is what the guard was
designed for. `dayProtectiveStopEnabled` is already false, so nothing else rode
on the arm flag.

**What still limits a bad day:** the −7.5% drawdown halt (three full-size
losers), the step-down after 2 consecutive losses (50% cut), one entry per symbol
per session, the 60-minute stagnation exit, and the through-stop protective close.

**Pre-committed:** revisit at the 10-session review. If the sizing reverts to
1.25% / 2R, the 2/1 band is coherent again and the guard goes back on with it. If
2.5% is kept, the guard cannot work at this goal height, and a give-back rule
would need a floor **below zero** — a band at least one trade-step wide, which is
a code change and a new decision, not a lever.

## 2026-09-15 — the universe widens past the index: 29 liquid biotech names

**Why.** The operator's observation — pharma has the big gainers — checked against
the loop's own record, which supports it on a small sample. The edge-leak scan's
sector dimension over 40 sessions:

| sector | live n | mean R | paper control |
|---|---|---|---|
| Health Care | 4 | **+0.12** | n=5, +0.43 |
| Industrials | 2 | +0.27 | n=9, +0.23 |
| Information Technology | **34** | **+0.03** | n=33 |
| Financials | 4 | −0.33 | n=6, +0.23 |

Over half the live book is Information Technology, and it is flat. Health Care is
among the best on BOTH books. n=4 is a hint, not evidence — the scan's own bar is
n ≥ 15 — which is exactly why this is a widening to be measured rather than a
sizing change.

**What was added (29).** Every name verified against LIVE quotes at the time of
the change, not from a remembered list, and every one clears the screener's own
filters (`minPrice` 5, `minAvgVolume` 1,000,000):

ACAD ALNY ARWR BEAM BMRN CORT CRSP CYTK DNLI HALO ILMN INSM IONS IOVA NBIX NTLA
NVAX PCVX PTCT RARE RGEN ROIV RVMD SMMT SRPT TGTX TWST VCYT VKTX

Universe 528 → **557**; Health Care 59 → **88**. Seven of the obvious large caps
(AMGN, BIIB, GILD, INCY, MRNA, REGN, VRTX) were already in the index list, so the
addition is genuinely additive.

**What was excluded, and why the check paid for itself.**

- **RXRX** — 18.8M shares/day, the most liquid name on the candidate list, and
  **$3.41**: under the price floor. Liquid and still out.
- **MDGL, KRYS, UTHR, AXSM, JAZZ, ARVN** — all under 1M average volume. MDGL at
  $540 and KRYS at $340 trade 350–400k shares: high price, thin tape, and exactly
  where a marketable limit gets a bad fill.
- **APLS, BPMC, DVAX, EXAS, FOLD, NUVL, SAGE** — no quote returned. Likely
  acquired or renamed; a symbol the provider cannot price does not go in.

**The risk this does NOT take.** Small-cap catalyst biotech is the obvious way to
get this wrong: a name at +40% on 20× volume scores near 100 on a momentum and
relative-volume screener, and the loop would buy it after the move with a 2.5%
stop, at roughly 100% of equity in notional. The filters above exclude most of
that, and the end-of-day flatten (`endOfDayFlattenMinutes` 5, unconditional)
means no position carries a biotech gap overnight. What remains is intraday: a
halt with a resting bracket cannot be exited, and reopens through the stop. The
`entry_extension_shadow` already measures the buying-the-spike half.

**Scan budget.** +5.5% (528 → 557). Friday's rate-limit retry took `unscored`
from 67-of-562 to **1-of-562**, so there is headroom; `screen_data_incomplete`
is watched nightly by the routine and will show it if this eats the margin.

**Pre-committed reading.** Live takes only what clears `liveMinSignalScore` 81;
PAPER takes every signal at full size, which is the control arm that already
exists. So the paper book builds the sector evidence first. At **n ≥ 15** Health
Care trades since 2026-09-15 on either book, read the scan's sector bucket: if
the PAPER control is negative over that window, the widening is not working and
the biotech names come back out — a paper book that cannot make money on them is
not a case for risking real money on them. No sizing, cap or floor changes with
this.

## 2026-09-15 — the shape of the day, sampled

**The question that had no answer.** "We were over 3% for at least five minutes
this morning, and now we're not." True, and unanswerable twenty minutes later:
the app kept the day's OPENING equity (`autotrade_daily_baseline`) and overwrote
the current figure every tick. Nothing recorded what happened in between.

**Why not poll every second**, which is the obvious version of the fix. The
account figure comes from the broker, and that API is rate-limited to roughly 2
requests per 2 seconds **shared with the order paths** — polling it per second
would starve placement and cancellation in order to watch a number. It is also
unnecessary: the day is computable locally. Realized P&L comes from the ledger,
and the mark needs one quote per open position, which the tick ALREADY fetches
for the stop ratchet and the stagnation check. The provider caches quotes, so
the sampler adds no provider calls in the ordinary case.

60-second resolution is the cadence every other rule in the loop acts on, and it
puts five samples inside a five-minute window.

**Three series, because the whole point is that they differ.**
`autotrade_day_marks`, one row per tick:

| column | what it is | who decides on it |
|---|---|---|
| `realized_usd` | what the loop has BANKED | every day-level halt, since 2026-09-14 |
| `unrealized_equity_usd` | the mark on the loop's own open STOCK positions | a flatten-at-goal rule, if built |
| `account_equity_usd` | the broker's net liquidation | what the operator sees |

On a session with no hand trading the first two sum to the third's move. The gap
between the first two is exactly the open argument — whether reaching the goal
should FLATTEN — and this table is its evidence rather than one morning's
impression. Percentages are derived on read and never stored: a stored
percentage is a second derivation of the same quantity waiting to disagree with
the dollars beside it.

**What the mark deliberately excludes.** Live OPTIONS positions: pricing a
contract needs a chain fetch, far too expensive per tick. `open_options` records
how many are excluded, so a reader can tell a complete mark from a partial one
instead of assuming — which is why the column is `unrealized_EQUITY_usd` and not
`unrealized_usd`. The same reasoning covers a quote that fails: that name drops
out of the mark, the row still records how many positions were open, and a
partial mark with a known position count beats no row at all.

**The reading.** `GET /api/journal/day-marks?date=&goalPct=` returns the series
plus a summary: peak and trough for each of the three, how many samples marked
at or above the goal, and how long that ran — in minutes derived from the sample
CADENCE, not from a wall clock, so a gap in the samples (a restart, a stalled
tick) cannot read as time spent above the goal. `goalPct` defaults to the
configured target but is overridable, because judging a past session by today's
goal is the filter-history-by-live-config mistake.

**What this is for.** Two weeks of it answers the question the flatten decision
actually turns on: how often does a 3% MARK appear while the realized day never
gets there, and how often does that mark survive to the close? Until then the
day-level halts are unchanged — this records, it does not act.

---

## 2026-09-15 — the day's loss budget is one number, fixed at the open, and it is the loop's own day

`maxDailyDrawdownPct` is one rule: stop opening live positions once the loop has lost
this much of a session. It had **four** implementations, and on a live account they
disagreed by 6x.

| where | numerator | denominator | on 2026-09-15 |
| --- | --- | --- | --- |
| `riskCheck.daily_drawdown_halt` | the loop's realized day | `accountEquityUsd` — this tick's net liquidation | -$44.39 |
| `optionsRiskCheck.daily_drawdown_halt` | the options book's day | same | -$44.39 |
| `liveExecute`'s scale-in gate | the loop's realized day | same, inline | -$44.39 |
| `guardrails.daily_loss_halt` | **the whole ACCOUNT's** realized day | `liveMaxDailyLossUsd` — the cap ANCHOR equity | -$44 |
| (`dailyTarget`, for the +3% goal) | the loop's realized day | the day's OPENING baseline | +$110.83 at 3% |

Both halves were wrong, and the fifth row is how you can tell.

**The denominator.** A drawdown is measured *from* somewhere. Putting the current value
in the denominator puts the quantity being limited on both sides of the comparison, so
the allowance chases the loss down and the effective budget depends on the path the day
took. It also has to be the denominator the GOAL uses, or the two day-level rules are
percentages of different dollars — which is what happened: a 3% goal worth $110.83
against a 7.5% halt worth $44.39, a session the loop had to win by more than it was
allowed to lose first. No edge repairs that.

The $591.81 reading was real, and that is the point: the account held 129 operator-bought
SPY 0DTE puts decaying from $0.29 to $0.035 (-90.2% on the day, -$3,288.50 unrealized),
which took net liquidation from $3,699.78 at 09:38 ET to $591.81 at 15:01 ET in steps of
exactly $129 — 12,900 shares-equivalent moving a cent at a time. Every percentage-of-
equity number the loop uses followed it down: `liveMaxOrderUsd` $5,550 -> $888,
`liveMaxDailyLossUsd` $277 -> $44.

**The numerator.** `AccountState.realizedPnlTodayUsd` is deliberately account-wide (the
worse of the broker's day-minus-unrealized and every exit the journal dates today,
`webull`-tagged operator rows included). That is right for a hand-placed order on the
Trade page and wrong for the loop: an operator's own realized loss halts the loop's
entries. This is verbatim the correction PR #610 made to `dailyTarget` on 2026-09-14 —
its note says "a manual LOSS could halt the book just as easily" — which checked
`riskCheck`'s percentage halt, found it already loop-scoped, and never looked at the
dollar twin. The dollar twin is the TIGHTER of the two, so it is the one that decides.
**That is the gap, and it is the "assert at the CONSUMER" rule again: the audit stopped
at the two implementations it knew about.**

### What changed

- `services/autotrading/dayLossBudget.ts` (new, pure): `dayLossBudgetUsd(pct,
  dayStartEquityUsd)` and `dayStartEquityUsd(baseline, etDate, currentEquityUsd)`. One
  derivation; every row of the table above calls it.
- `RiskCheckContext.dayStartEquityUsd` is **required**, not optional-with-a-fallback: a
  caller that forgot it would silently keep the old behaviour, which is the bug. Ten
  call sites each had to decide. The three backtests pass `equity - dailyPnl`, which is
  the replayed day's opening equity exactly (both are incremented by the same amounts
  and the day's P&L resets per day); the live, paper and preview paths pass the
  baseline row, falling back to the current reading before the day's first tick.
- `buildLiveTradingConfig` sets `maxDailyLossUsd` from the same budget, not from the
  stored `liveMaxDailyLossUsd`. `liveCaps.ts` has always described the two as agreeing
  "exactly"; they did not. The stored cap keeps its other jobs (the human path, the cap
  card, the tuner's suggestion), and nothing is loosened that `maxDailyDrawdownPct` did
  not already permit — `riskCheck`'s percentage halt reads the same budget and blocks
  first.
- The loop's guardrail account state carries the LOOP's realized day
  (`withLoopRealizedToday` -> `strategyDayFor`, the derivation `dailyTarget` and the
  results calendar already share). The human Trade page is untouched.
- `guardrails.daily_loss_halt` gates **opens only**, like `max_orders_per_day` beside
  it. A halted day used to refuse the stagnation and end-of-day closes too — the same
  shape as the 80 `live_time_exit_blocked` rows the order cap produced on 2026-08-24/25
  before it was given this rule. Refusing an exit does not limit a loss; it leaves one
  running.
- The dashboard's `dailyDrawdownHaltLevel` reads the same function, so the card and the
  halt name the same number.

### Pre-committed check

On the next session the risk-check journal's `daily_drawdown_halt` line reads
"...% of the day's opening $X" where X is `dailyTarget.baselineEquityUsd` — not
`currentEquityUsd` — and `dailyDrawdownHaltLevel` on the dashboard equals
`-(maxDailyDrawdownPct/100) x baselineEquityUsd`. If a hand trade is closed at a loss
that day, `strategyPnlUsd` and the halt's "today" figure stay equal to each other and
unaffected by it.

---

## 2026-09-15 (second) — three things the app knew and could not say

Not one defect but one shape: a fact the app had, computed correctly, that reached
nobody. Each was found by a question nobody could answer from the record.

### 1. A broker holding that grew after import drifts forever, silently

`importFromPreview` matches an incoming broker position to an open journal row by
CONTRACT — symbol, type, strike, expiration — and, on a match, counts it `skipped`.
Quantity is never compared. So a position imported at 7 contracts stays at 7 however
many the operator adds afterwards.

Found on 2026-09-15: the broker held **129** SPY 755P contracts against the journal's
**7**, an 18x gap, discovered only because someone went looking for why net liquidation
had fallen 84% in a session.

**The missing edit is not the defect.** The sync only ever ADDS a position the journal
lacks and CLOSES one the broker no longer shows, deliberately: a row carries one
`entryPrice`, so raising its quantity to match a later add would invent an average
nobody paid and would overwrite a journal entry a human may have written. The defect is
that the disagreement produced no trace.

`comparePositionsToBroker` was built for exactly this question and was an on-demand POST
nothing called on a schedule — "visible the moment you look" only helps someone looking.
It is now split into a pure `comparePreviewToJournal(preview, journal)`, which the sync
runs on the preview it already has (no extra broker call), AFTER the close and import
passes so a just-imported contract does not read as drift. Every mismatch journals
`position_quantity_drift` with both quantities, once per contract per ET day.

### 2. Decision 9's yardstick was computed where nothing could read it

`SizingReview.meanRedDayPct` and `worstDayPct` are the two numbers Decision 9's bar is
written in — "mean red day <= -1.5%", in percent, off the strategy series. They were
built in `gatedSwitchesData.ts`, consumed inside the advisor, and carried on no response
body. The nightly review is instructed to quote them and had to recompute them by hand.

What IS readable is the results calendar's field of the same name — and it is a
different quantity. `dayPctOf` is `accountGainPct ?? strategyGainPct`, account-first by
design, because that page answers "how am I doing". On 2026-09-15 it read **-20.84%**
against this series' **-1.96%**, because the account carries the operator's own trading
and the strategy series does not. Two fields, one name, a tenfold difference, and the
readable one was the wrong one for the rule.

`TuneAdvice` now carries `review`. **A value computed where nothing can consume it is
the same defect as one nothing reads at all** — the guards in CLAUDE.md stop at config
fields and function parameters; this one was a struct built and dropped at the route
boundary.

### 3. The equity guard sees jumps, not slides

`evaluateEquitySync` compares each reading to the last ACCEPTED one. That is right for
what it does — it REJECTS, and a slow decline is usually real, so rejecting one would
freeze equity at a stale figure. But it leaves the session's own shape unrecorded, and a
feed fault arriving in sub-threshold steps is exactly as damaging as one arriving in a
single lurch while producing no row at all.

On 2026-09-15 net liquidation went $3,699.78 -> $591.81, **-84%**, in steps of 5.4%,
7.5%, 14.8% and 11.4% — every one inside the 25% guard. The only trace was 143
`live_caps_reanchored` rows, which record the CONSEQUENCE one step at a time and never
the move.

`equity_moved_far_from_open` now journals once per ET day when net liquidation is more
than `equitySyncMaxJumpPct` from the day's opening baseline, carrying `marketValueUsd`,
`cashBalanceUsd` and `brokerDayPnlUsd`. It rejects nothing and holds no cap — the split
is the point: a real move shows up in positions or cash, and a feed contradicting itself
does not.

### Pre-committed check

On the next session with a hand-held position whose quantity differs from the journal's,
exactly one `position_quantity_drift` row appears for it, carrying `brokerQty` and
`journalQty`, and the journal row's `remainingQuantity` and `entryPrice` are unchanged.
`GET /api/journal/tune-advice` returns a `review` object whose `meanRedDayPct` differs
from the results calendar's on any day the account and the strategy diverge.

---

## 2026-09-15 (third) — one switch turned off two nets

Turning the give-back guard off this morning disabled the **day-protective stop** as
well, and nothing said so.

The guard went off for reasons entirely its own: at 2.5% risk with a 1R target each
trade moves the day ±2.5 points against a band one point wide, so a win then a loss
halted the book after two trades. `giveBackArmPct` and `giveBackFloorPct` both went to
null.

`stopAdjust.ts`'s day-protective stop — which tightens a live position's stop just
enough that a stop-out cannot drag the day below a floor, and no further — was gated on
`dt.giveBackArmed` and took its floor from `dt.giveBackFloorPct`. With both null it can
never fire, at any setting of its own flag. So `dayProtectiveStopEnabled` was left
describing behaviour that had become impossible: a config field whose execution path no
longer reads it, which is the disease CLAUDE.md's third guard exists for, arriving
through a door that guard does not watch — the field IS read, by code that can no
longer run.

### What changed

- **`dayProtectiveStopFloorPct`** (new, nullable): the day level, in % of the day's
  opening equity, that no open trade may drag the day below. The rule reads its own
  floor and no longer waits for any arm. Either net now works with the other off.
- **`null` is the off switch, and the only one. `0` is a real floor** — "never let an
  open trade take the day negative". The guard's floor could not express that: it must
  satisfy `0 <= floor < arm`, so 0 read as unconfigured. One more reason the two should
  never have shared a field.
- **Scaled like everything else on the day.** `dayProtectiveFloorPct` on the status is
  the configured value times the regime overlay's `goalScale`, so a 35% cut day
  protects 0.65% where a full day protects 1% and the day keeps its shape in R. The
  guard's floor has been scaled since 2026-09-08; this is the same rule, not a new one.
- **One derivation of "dollars above a day level"**: `headroomToLevelUsd` in
  `dailyTarget.ts` now produces both `headroomToFloorUsd` and
  `dayProtectiveHeadroomUsd`. Two rules aiming at day levels, both setting real stops
  from the answer, is exactly the shape that produced the 2026-09-08 bug where this
  rule read `cfg.giveBackFloorPct` while the guard read the status.
- The rule is still **off by default** and still changes where real stops sit, so it
  stays behind its flag.

### Pre-committed check

With `giveBackArmPct` and `giveBackFloorPct` null and `dayProtectiveStopEnabled` true
with a floor, `GET /autotrade/dashboard`'s `dailyTarget` carries
`dayProtectiveFloorPct` and `dayProtectiveHeadroomUsd` while `giveBackFloorPct` and
`headroomToFloorUsd` are both absent — and a live position whose stop would breach that
floor gets a `live_stop_ratcheted` row naming it.

## 2026-09-16 — the goal rate could only ever drop the MISSES

Prompted by one answer from the operator: *"No manual trading today."*

2026-09-16's results row was flagged `manualTrading` on a day neither book
traded. The day-marks series settles what happened, because it samples all three
series once a tick:

| ET | account equity | realized | unrealized | open positions |
| --- | --- | --- | --- | --- |
| 00:00:29 | 30,204.81 | 0 | 0 | 0 |
| **04:03:42** | **30,011.31** | 0 | 0 | 0 |
| 04:06:53 | 30,011.30 | 0 | 0 | 0 |

One −$193.50 step at 04:03 ET — hours before the open — then flat for all 798
samples. No loop entry (391 `live_risk_blocked`, every one on buying power), no
hand trade, nothing open to mark. It is the broker settling the previous day's
option expiry into an account whose baseline had already been captured at ET
midnight. The flag fired at 0.64% against its 0.5% threshold and named a cause
that did not exist.

### The flag is not the bug. What reads it is.

`buildSizingReview` judges its goal rate over

```ts
sessions.filter((r) => r.goalBasis === 'strategy' || !r.manualTrading)
```

and `goal_basis` was written by **exactly one function**,
`markDailyTargetReached`. So the column existed only on days the goal was
REACHED, and every MISS was null forever. Read the filter against that:

- a **reach** under the current evaluator carries `'strategy'` and is kept by the
  first clause, whatever the flag says;
- a **miss** has no basis, falls to the second clause, and is **dropped** the
  moment the divergence flag fires.

Numerator protected, denominator leaking, in one direction, on the number
Decision 7 keeps or reverts the trial by. One reach plus one flagged miss reads
**100%**. And the flag fires on days nobody traded, so this was routine rather
than a corner. The note in the code claimed "the exclusion retires itself once
the window holds no pre-change rows"; it could never retire, because misses were
always pre-change rows by construction.

**The unit test for this filter passed from the day it was written.** It asserts
the right verdict on a miss carrying basis `'strategy'` — a fixture the producer
could not emit. CLAUDE.md's rule is "assert at the CONSUMER, not the producer";
this is its mirror image, a consumer asserted against an input that never
arrives. Testing the filter proved nothing about what reached it.

### The basis describes the EVALUATOR, so every session has one

`recordGoalBasis` writes the basis once per session from `updateDailyTarget`,
first-write-wins so a reach's own stamp is never clobbered. Both writers take it
from one exported constant, `DAILY_TARGET_BASIS`, so the two places that record
the same quantity cannot disagree — they do not each decide it. A missed session
now carries `'strategy'` and is counted; the null case stays exactly what it
always meant, a session that ran before the basis was tracked.

History is **not** backfilled. The sessions already on the book (2026-09-11,
-14, -15, -16) ran across the evaluator's own changeover, and "unknown is not a
match" is the same rule `risk_per_trade_pct` already follows — inventing a basis
for them is the 2026-09-14 mistake with a different column. They stay out of the
rate; the stamp accumulates forward.

### A rate now reports its denominator

`SizingReview.goalRateJudgedSessions` sits beside `goalRatePct`, because a rate
with an unstated denominator is what hid this: "100%" over a silently halved
window reads exactly like 100% over the whole one. Compare it against
`activeSessionsSinceChange` and any future exclusion has to show itself.

### Pre-committed check

On the first session after this deploys, the baseline row carries
`goal_basis = 'strategy'` **before** any reach — and if the day ends without
one, `GET /api/journal/daily-results` shows that date with
`goalBasis: 'strategy'` and `goalReached: false`. On the current book
`goalRatePct` is `null` over `goalRateJudgedSessions: 0`; it must stay null
until a stamped session lands, and must never read 100% off a single reach while
misses sit in the same window.

## 2026-09-16 (second) — the flag named one of its causes

The same day's row, from the other end. `manual_trading` asserted a cause the
data cannot establish, and on 2026-09-16 it asserted the wrong one: the operator
confirmed no hand trade, and the day-marks series shows the whole −$193.50
arriving at 04:03 ET with both books flat.

Everything that crosses the 0.5% line: a deposit, a withdrawal, hand trading,
commissions and fees, margin interest, overnight settlement of the previous
session, and the unrealized mark on anything still open at the close (options
are deliberately not flattened, so a single open contract can cross it alone).
Seven causes, one boolean, and a name that picked one of them.

**Now:** `account_strategy_diverged`, which is what the comparison measures. The
column is renamed in place, so every stored flag is kept — each of those days
really did diverge; only the label claimed to know why. Two figures join it:

- `divergence_usd` — the gap in dollars (the account's move minus the loop's
  realized P&L), because "a $30,000 deposit" and "a −$193.50 settlement" are
  spoken of in dollars and a percentage against a threshold is not enough to
  tell a rounding-width gap from a transfer.
- `pre_open_move_usd` — how much of the account's move landed BEFORE the
  opening bell, from the day-marks samples. This is the one split the data can
  actually make. The loop ticks from ET midnight and the day's baseline is
  captured before the broker has finished clearing the previous session, so
  settlement, fees and interest post *inside* a session the loop had not begun
  to trade. Null when the samples cannot say, never 0 — a loop that started
  mid-session never saw the window, and 0 would assert a quiet night.

`isBeforeSessionOpen` mirrors `isAfterSessionClose` (false on weekends and
holidays for the same reason: "the market is shut" and "today's session is still
ahead" are different facts).

The calendar's badge is **D** rather than **M**, and it states the gap and the
pre-open share instead of listing three causes out of seven. Its tooltip read "a
deposit, a withdrawal, or manual trading" — a list that excluded what actually
happened.

**Not changed:** the 0.5% threshold, and which column any rule reads. This is
what the record SAYS, not what it decides. The goal rate's use of the flag is
the subject of the section above, and after that change a strategy-basis row is
counted whatever this flag says.

### Pre-committed check

After the deploy, `GET /api/journal/daily-results` returns
`accountStrategyDiverged` with `divergenceUsd` on every row that has account
figures.

**Verified on the deployed box the same evening.** 2026-09-16 reads

```json
{ "accountStrategyDiverged": true, "divergenceUsd": -193.51, "preOpenMoveUsd": -193.51,
  "strategyPnlUsd": 0, "liveTrades": 0, "goalBasis": "strategy", "goalReached": false }
```

The two figures come from different tables — `divergence_usd` from the results
row's own equities, `pre_open_move_usd` from the day-marks samples — and on this
day they agree EXACTLY rather than approximately. That is not a coincidence and
it is the substance of the check: they can only be equal when the loop realized
nothing (so the account's whole move is the divergence) AND nothing moved after
the opening bell (so the whole divergence is the pre-open step). Equality is
therefore the proof that the session itself was flat and the money left
overnight. On any ordinary trading day the two will differ, and the gap between
them is what the session did.

A note against a wrong expectation, since this section is what a later reader
checks against: the pre-open window ends at the BELL, not at the last step in
the series. 2026-09-16's account equity moved at 04:03 and again at 04:06 and
then held 30,011.30 until 09:29, so the pre-open move is measured to that last
09:29 reading (-193.51) and not to the 04:03 one (-193.50).

## 2026-09-17 — the paper options book fills the way live prices an order

Found while reading the unconstrained paper book for lessons the live rules do
not already encode. The stock side gave two (the slow-bleed shape of the
full-size loser, and the stop pinned at the 2.5% cap on 77 of 85 entries). The
options side gave a measurement bug in the control arm itself.

### What the paper book was booking

A paper options exit filled at the chain's **midpoint**, **instantly**, on the
tick a rule fired. Both halves are prices nobody would have paid:

1. The midpoint is an average of a price nobody is offering and one nobody is
   bidding. Since PR A the live close goes out at the **bid** (OPRA, then the
   chain's bid, then 5% under the mark) — `sellableExitLimit`. Paper priced
   nowhere near it.
2. A rule fires on the tick the mark is at an extreme, by construction: a
   take-profit fires *on the spike*. On 2026-09-11 the paper book booked HOOD
   260911C116 at 1.48 — +72% in three minutes — while the live order at 1.40
   against that same 1.47 mark never filled and the contract expired
   worthless. Filling on the deciding tick is filling on the spike.

Over the 26 paper trades on the book:

| exit-fill assumption | mean % of premium |
| --- | --- |
| at the mark (what paper did) | **+16.4%** |
| at mark × 0.95 (live's own buffer) | +10.6% |
| …and without the HOOD fill live provably could not get | **+8.5%** |

Six of the ten paper take-profits are ≥ +60% inside 90 minutes. The decision
to keep `optionsTakeProfitPct` at 60 and the widening to two live slots both
rest on the +16.4% figure.

### Now

- **One pricing, two callers.** `sellableExitLimit`, its spread twin, the
  marketable buffer and the OPRA-first resolver moved out of
  `liveOptionsExecute.ts` into `optionsExitPricing.ts`, a leaf that imports
  only the tick grid and the two read-only Webull providers; the chain fallback
  each book prefers is passed in. Neither executor imports the other. The live
  file re-exports the names so its tests and callers read as before.
- **Decided, then filled.** A rule-driven paper exit is decided on tick N at
  the sellable price s_N and filled on tick N+1 at `min(s_N, s_N+1)` — what a
  resting sell limit chased downward does: it fills at its own price if the
  market held or rose, and at the re-priced level if the market left. An
  up-spike that reverses fills at the post-spike price; a down-spike fills at
  the low, because a limit placed there filled at once — the honest asymmetry
  of a resting sell. Clock-driven exits (`hard_time`, `stagnation`, the DTE
  time-exit) are not selected on the mark and fill on their own tick.
- **The pending decision lives in memory**, like the live chase state. A
  restart forgets it; the rule re-fires next tick; the fill lands a tick later
  than it would have. Self-healing, and not worth a column for a state the
  loop re-derives in a minute.
- **The row says what happened.** `exit_decided_at` (the rule), `exit_at`
  (the fill), `exit_decision_mark` (what the rule saw) against `exit_price`
  (what the close got), and `exit_fill_basis` (`bid` / `mark` / `last`). The
  journal gains `options_paper_exit_decided`, and the close rows carry
  `decisionMark`, `restingLimit`, `fillPrice`, `fillBasis`, `filledOn`
  (`same_tick` / `next_tick` / `next_tick_unquoted` / `next_session`).
- **The paper executor prices nothing of its own.** `optionTick.test.ts`'s
  rounding guard now scans both the live file and the shared module (the same
  three rounding sites, split 2 + 1) and adds a second check: no
  `roundOptionPrice(` and no `× 0.95` arithmetic in `optionsExecute.ts`.

### Two series, not one

Rows closed before this date filled at the mark and carry a null
`exit_fill_basis`. Every read of the sleeve that spans the boundary — the mean
% of premium, rule L5, the 60/40/30 take-profit comparison — must say which
series it is on. The take-profit level is re-scored on the new series only,
once it holds ~20 trades, and not before.

### Pre-committed check

The first `options_paper_exit_decided` in production is followed one tick
later by a close row whose `fillPrice ≤ restingLimit ≤ decisionMark × 0.95`,
with `filledOn: 'next_tick'`. On the first take-profit that fires on a spike,
`fillPrice` sits well under `decisionMark` — that gap is the number this
change exists to stop booking.

## 2026-09-17 (second) — the paper book's excursions, and the distribution behind the tuner

The second lesson from reading the unconstrained paper book. The proposal as
first written was "record the worst price since entry beside the best" — a
tick-sampled MAE column on both position tables. It was not built, because the
quantity already exists and is measured better: `services/excursion.ts` has
computed MAE/MFE from 5-minute bars for closed live stock trades since July,
`excursionTune.ts` sizes a stop from the winners' heat it reports, and
`exitTuneValidation.ts` replays tighter stops on the live book walk-forward. A
second, cruder derivation of the same number is the disease CLAUDE.md names.

What that machinery did NOT do:

1. **See the paper book.** Every excursion read, and everything downstream of
   it, ran over the journal's own ledger. The paper book is the larger sample
   (141 closed trades to live's ~85) and the unconstrained control arm. The
   2026-09-16 read that prompted all of this — winners reach +0.25R in a
   median 12 minutes, losers take a median 275 minutes to travel the full 2.5%
   to the stop — was done from the paper rows' best-price column alone, because
   their worst price was recorded nowhere. It is recorded: in the bars.
2. **Report a distribution where the question is a threshold.** A stop is a
   line; what it costs is the share of winners whose worst dip crossed it
   before they won. The report carried an average MAE.

### Now

- `paperExcursions.ts` maps a closed paper row onto the same `ExcursionInput`
  the live route builds — side, the FROZEN initial stop, ET dates from the
  epoch stamps, the entry minute for the intraday window. The quantity is the
  ORIGINAL (risk at entry over the initial stop distance), not the row's, which
  a scale-out has reduced while banking the slice: measured off the remainder,
  every R on a scaled-out trade would inflate. `realizedR` therefore equals
  `paperRealizedR` by construction.
- `GET /api/journal/excursions?book=paper` runs the identical measurement;
  `book=live` (the default) is unchanged and now labelled. One loop,
  `collectExcursions`, runs both — cap, concurrency and the coverage identity
  (`trades + undated + overCap + unavailable = population`) are shared.
- Each resolution's averages carry `winnerHeatR` (|MAE| over rows that closed
  positive) and `loserMfeR` (MFE over rows that closed negative) as
  `{ n, p50, p75, p90 }`. A scratch belongs to neither. The percentile is the
  one `excursionTune.ts` sizes from, moved to `util/percentile.ts` so the
  report and the tuner cannot disagree by a rank.
- The Journal analytics panel prints the intraday winners' heat (median, p90,
  n) and the losers' median MFE under the resolution split, and its Excursions
  tab has a Live / Paper switch that runs the same request with `book=paper`.
  Both are pinned at the consumer in `JournalAnalyticsModal.test.tsx`: a
  quantile the server computes and nothing renders is not shipped.

### What was deliberately not built

A sum over trades of "if the stop had sat at *f* × today's distance, each
trade whose MAE crossed it loses *f*R instead". It was the first thing
sketched, and it is the peak-minus-distance model `exitTuneValidation.ts`
discarded: it reports every tightening as an improvement because it charges a
tighter stop for nothing a real order pays. The honest path replay exists for
the live book; extending it to the paper book is the follow-up, not this.

### Pre-committed reading

`GET /api/journal/excursions?book=paper` on the deployed box: the coverage
identity holds; the intraday partition reports `winnerHeatR` with n in the
dozens. The reading for task #59 is then the winners' heat p90 against the
1.0R stop, on both books; a p90 well under 1.0 on both is the case for
`maxRiskAtrFraction` to bind harder or the cap to move, and it goes to the
replay before it goes to the config.

### First reading (2026-09-17, deployed at 17:44 UTC)

Both identities hold exactly: paper 142 measured + 0 undated + 0 over cap + 1
unavailable = 143 closed; live 118 + 26 + 0 + 6 = 150.

| intraday rows | n   | winners | heat p50 / p75 / p90 | winners a stop at 0.5R / 0.75R / 1.0R stops first | losers | losers' MFE p50 / p90 |
| ------------- | --- | ------- | -------------------- | ------------------------------------------------- | ------ | --------------------- |
| paper         | 98  | 65      | 0.23 / 0.50 / 0.85   | 17 / 9 / 2 of 65                                  | 32     | 0.18 / 0.80           |
| live          | 78  | 26      | 0.09 / 0.18 / 0.32   | 1 / 1 / 0 of 26                                   | 34     | 0.17 / 0.65           |

The two books disagree, and the disagreement is the finding. The pre-committed
case for a tighter stop was "a p90 well under 1.0 on both books"; the live book
reads 0.32 and the paper book 0.85, and on room the paper book is the one to
believe, because the live book's exit rules choose who counts as a winner. With
the scale-out off (and, before 2026-09-14, mostly refused by the broker) and
the breakeven ratchet at +0.25R, a live trade that reaches +0.25R and comes
back to entry closes at breakeven — a scratch, in neither partition — so a
live "winner" is by construction a trade that never dipped after it started
working. The paper book has banked 67% at +0.25R, so a trade that reached
+0.25R is a winner whatever the remainder does, and its heat is the room a
trade needed to GET to +0.25R. On that record a stop at half today's distance
stops out 17 of 65 such trades (26%) before they get there; at three quarters,
9 (14%); at the full distance, 2 (3%).

The honest path replay agrees from the other side
(`GET /api/journal/exit-tune-validation`, live book, 77 same-session trades):
the winners'-heat fixed point walks `stopAtrMultiple` from 1.5 to the 0.5
clamp and replays at the same mean R (0.06 against 0.06, CI −0.13…+0.12,
`inside_noise`), with the exit mix moving from 2 stops / 7 targets / 35 time
exits to 16 / 17 / 9; the one-step candidate (1.25) reads +0.01R (CI
−0.04…+0.04, `inside_noise`); on the 39/38 walk-forward holdout the tuner
refuses to act (16 winners, needs 20). A tighter stop trades slow time exits
for more stop-outs and more target hits, and nets nothing per trade.

**Decision: no change to `maxRiskAtrFraction` or the 2.5% cap** (task #59 is
closed on this reading). What the replay does not price is slot turnover —
time exits 35 → 9 free a slot sooner — which is a flow claim, and flow is
measured by the daily-goal sweep, not by per-trade R. The paper book's own
walk-forward (`exitTuneValidation` is live-only) stays the follow-up.

## 2026-09-18 — options entries are priced from the real-time ask

The operator asked on 2026-09-17 whether the options sleeve used the account's
OPRA entitlement ("OPRA Real-Time Non-display"). It did for the exits — live
since 2026-09-12, paper since 2026-09-17 — and not for the entries. Both books
re-fetched the contract from the Yahoo-sourced chain at placement, ~15 minutes
delayed, and built the buy limit from its midpoint plus 5%; the sizer's fill
premium and the fat-finger reference were that same stale midpoint. On a 0DTE
contract a quarter of an hour is the difference between a limit that fills and
one that rests under a market that has already left, and the contract count
was off by whatever the premium had moved in the meantime.

The change, one module and two callers per side (CLAUDE.md's rule):

- `optionsExitPricing.ts` gains the buy side: `buyableEntryLimit` — the ask
  with the 5% buffer on top, rounded UP onto the tick grid in one shared
  `buyLimitFromRaw`, the buffered mark when there is no ask — and its spread
  twin, long ask minus short bid. The resolver is `resolveContractQuote`;
  `resolveExitQuote` stays as its name on the sell side.
- The live entry resolves each leg through it, keyed by the contract symbol
  the signal already carries, refuses a last-trade-only print as before,
  sizes and references at the ask, and journals `priceBasis`, `quoteSource`,
  `quoteAgeMs` and each leg's quote on `live_options_order_placed`.
- The paper entry fills at the same ask — the mark, or its last trade, when
  no ask exists; the paper book never refused a last-trade print — and says
  which on `options_paper_order_placed` (`fillBasis`, `quoteSource`).
- The rounding guard in `optionTick.test.ts` now counts TWO sites over the
  live file and the shared module, one per side of an order, and the live
  file rounds nothing of its own.

Nothing changes when no two-sided quote exists: every existing case that
priced from a mark-only chain prices identically, which the untouched entry
tests prove. The paper book's entry series changes on this date the way its
exit series did on 09-17.

### Pre-committed check

The first `live_options_order_placed` after the deploy carries
`priceBasis: 'ask'` and `quoteSource: 'opra'` with a `quoteAgeMs` under two
minutes, and its `limitPrice` is that ask plus 5% on the grid; the first
`options_paper_order_placed` carries `fillBasis: 'ask'`. A
`quoteSource: 'chain'` on a session where the OPRA route answers is the
finding to chase.

## 2026-09-18 (second) — the stock sleeve was spending the options sleeve's caps

The operator asked at 11:28 ET why no more live positions were opening. The
stock sleeve had an ordinary answer: its only repeat candidates were HOOD,
SNDK and COIN, all traded earlier in the session and refused by the
one-entry-per-symbol rule (`symbolReentryCooldownMinutes` 390, Decision 8 of
the 3%-goal plan), plus NOK under the conviction floor. The options sleeve did
not: every options entry from 10:01 ET was refused by a guardrail fed an
ACCOUNT-WIDE figure against an OPTIONS-ONLY cap.

- `max_orders_per_day` — `countTodaysOrders()` counted every opening intent on
  the account. Four stock entries (USDE, COIN, HOOD, SNDK) plus two options
  entries (HOOD 09:47, COIN 10:25) read "6 placed vs 6/day" against
  `liveOptionsMaxOrdersPerDay` from 10:27 ET, and 26 options signals (MU, COIN,
  NFLX, HOOD) had been refused by 11:36 with two placements on the sleeve's
  book.
- `account_exposure` — `buildLiveOptionsTradingConfig` pinned `maxExposureUsd`
  at 100% of equity, a copy of the equity sleeve's value before 2026-08-27 that
  never followed `liveMaxExposurePct` (155, then 190). The rule measures the
  whole account's market value, so with the stock book at its allowed size
  every options entry from 10:01 to 10:23 read "$55,716 vs cap $29,285" (11
  refusals) under a 190% allowance of about $57,700.
- `max_aggregate_open_risk` — shared with equity BY DESIGN, and it refused five
  options signals between 10:01 and 10:10 while the stock positions held the
  whole 7.5% budget. At 2.5% risk × 3 stock slots that budget is full whenever
  the stock book is, so the options sleeve could open only when a stock slot
  was empty. Widening it is an exposure decision, and the operator took it the
  same day: **`maxAggregateOpenRiskPct` 7.5 → 12.5** at 12:02 ET (2.5% × the
  five slots of both sleeves: three stock, two options). The daily halt stays
  at 7.5% of the day's opening equity; with every slot filled the book can now
  carry 12.5% of equity at risk before it, which is the trade-off the operator
  accepted.

The change, one derivation per quantity:

- `countTodaysOrders(now, assetKind?)` scopes the count to one sleeve; the
  options executor passes `'option'`, the equity executor `'stock'`; the human
  Trade page's cap stays account-wide.
- `liveExposureCapUsd(cfg)` in `liveCaps.ts` is the one ceiling both
  `buildLiveTradingConfig` and `buildLiveOptionsTradingConfig` call.
- Consumer tests in both live executors (the guardrail verdict with the other
  sleeve's orders on the account; the options verdict at 150% exposure under a
  190% ceiling) and a sleeve-scoped count test.

No parameter changed. The paper control took MU three times on the signals the
live sleeve refused (one flat at 4.55, two closed at 2.95 from 4.60 and 4.40),
so the day's refusals cost nothing in P&L; the caps still have to mean what the
operator set.

### Pre-committed check

On the first session with stock entries on the book, an options entry passes
`max_orders_per_day` with fewer than `liveOptionsMaxOrdersPerDay` options
placements that day, and a `live_options_entry_blocked` row naming
`max_orders_per_day` appears only once the options sleeve's own count reaches
the cap. An `account_exposure` refusal on the options sleeve reads a cap equal
to `liveMaxExposurePct` % of equity (about $57,700 at a $30.4k reading), never
the equity figure itself.

## 2026-09-19 — options contracts are selected on real-time data

PR #628 (2026-09-18) priced the options ENTRY from the real-time ask, and the
first session under it showed why that was only half the fix: the contract had
still been CHOSEN on the Yahoo-sourced chain, ~15 minutes delayed. Every entry
rule in `options/entryRules.ts` — the delta band, the spread filter, the
open-interest and volume floors, the IV band — and the premium the risk check
sizes on read the chain's numbers, and on the 0DTE names the sleeve trades those
ran 40–70% away from the live print (HOOD 0.57 against 0.99, IBM 0.51 against
0.95, COIN 0.55 against 1.95 on 2026-09-18). The order paid the live price for
a contract picked on a stale one.

The change, one new module and one call site:

- `optionsSelectionQuotes.ts`: `selectionCandidates` takes the nearest-the-
  money contracts of the signal's side, capped at the snapshot route's own
  batch limit (`OPTION_QUOTES_MAX_SYMBOLS`, 40, exported from the provider so
  the two cannot drift); `overlayLiveQuotes` replaces a contract's bid, ask,
  mark, volume, open interest, delta and IV from a fresh two-sided print and
  leaves everything else as the chain had it; `overlaySelectionQuotes` does
  the one fetch and never throws — no answer, an error, a stale or one-sided
  print all return the chain unchanged. Freshness is `freshTwoSidedPrint` from
  `optionsExitPricing.ts`, the same rule the entry and exit resolver applies,
  so selection and pricing cannot disagree about what "fresh" means.
- `optionsDecide.ts` overlays the chain right before `scanEntries`, after the
  IV-history write, so the IV-rank series keeps its one source. Filter
  levels, bands and weights are untouched; with no OPRA answer the decision
  is byte-for-byte the previous one, which the untouched decision tests
  prove. The signal carries `selection`, and `options_signal_generated` /
  `no_options_signal` carry `selectionQuoteSource`, `rePricedContracts`,
  `quoteAgeMs` (the oldest print used) and `quotesRequested`.

Both books share the decision, so both benefit. No parameter changed.

### Pre-committed check

The first `options_signal_generated` of the 2026-09-22 session reads
`selectionQuoteSource: 'opra'` with `rePricedContracts` above 0 and
`quoteAgeMs` under 120000, and the session's first placement carries
`quoteSource: 'opra'`. A `'chain'` selection on a session where the snapshot
route answers is the finding to chase; a `no_options_signal` whose reason is
"No contract passed entry rules" with `rePricedContracts` 0 on such a session
is the same finding.


## 2026-09-19 (second) — the leak scan's window applies to every section

Found while reading the day (2026-09-18): `GET /api/journal/edge-leaks?sessions=1`
returned the same trades, pairs and buckets as `?sessions=40`, and a _larger_
`no_live_row` (145 against 104). `collectBook` hands the scan every closed trade
beside the `sessionDates` it chose, and `runEdgeLeakScan` read `input.live.trades`
and `input.paper.trades` unfiltered: only `buildDayLevel` and `coverage.sessions`
honoured the window. The journal skips the attribution pairs against _were_
bounded to the window, so a narrow read paired forty sessions of paper trades
against one session of skips and reported the rest as "nothing the journal
explains" — the bucket whose whole meaning is a recording gap.

**The fix** is one function, `tradesInWindow`, applied once at the top of
`runEdgeLeakScan` to both books; the dimensions, the pairing, the attribution,
the day level and `coverage` all read its result. It is a date **range** on the
trade's entry date, not a membership test against the calendar's sessions: a
row stamped on a non-session date inside the window is `buildSessionPaths`'s to
fold onto its neighbouring session, as it already does, not the window's to
drop. `coverage` gains `liveOutsideWindow` / `paperOutsideWindow` — how many
closed trades the window excluded — so a reader can tell "one session" from
"one session of a one-session book". A full-window read of a book younger than
the window is unchanged, which the untouched scan tests prove.

**Pre-committed check.** On the deployed book, `?sessions=1&book=both` after a
session reports `coverage.liveTrades` equal to that session's closed live
trades, `coverage.sessions: 1`, and a `no_live_row` count no larger than the
`?sessions=40` read's.

## 2026-09-19 (third) — every settings change through the route is journaled

Found on 2026-09-18 while reading the day: the operator's `maxAggregateOpenRiskPct`
7.5 → 12.5, applied through `PUT /api/autotrade/config` at midday, left **no**
journal row. The route journaled eight transitions — the risk profile, `enabled`,
`accountEquityUsd`, the two live switches, the options strategy type,
`riskPerTradePct` (`sizing_changed`) and the tuner's flag — and nothing else. The
reason `sizing_changed` exists ("nothing else in the database can date that",
because the config row's `updated_at` moves every minute under the equity sync)
applies to every cap, slot count, cooldown and goal level just the same, and
each of them has been changed by hand during the trial.

**The change.** `diffAutotradeConfig(before, after)` (`db/autotradeConfig.ts`,
pure) lists every field that differs between two configs with its old and new
value, compared as JSON so a nested block counts once. The three stamps the
config sets for itself on a transition (`liveEnabledAt`, `liveOptionsEnabledAt`,
`autoTuneExitTunedAt`) are excluded: each already travels with the transition
that set it. The route journals the list as one `config_changed` row per PUT —
`detail: { fields: [{ field, from, to }] }` — after the dedicated rows, which
are unchanged; a PUT that changes nothing writes nothing. The loop's own writes
(the equity sync, the caps re-anchor, the gated switches, the tuner) do not pass
through the route and keep their own rows (`live_caps_reanchored`,
`config_auto_applied`, `auto_tune_*`).

**Tested at the consumer**: `routes.integration.test.ts` drives the PUT with two
changed fields and one sent unchanged, then a no-op PUT, and asserts the journal
holds exactly one row listing exactly the two.

**Pre-committed check.** The next hand change on the deployed box — any field —
shows a `config_changed` row on Recent activity within the same minute, carrying
the old and new value.

## 2026-09-19 (fourth) — the shorts switch reads the record it was written for

**The gap.** The gated-switch engine shipped on 2026-09-12 with the `shorts`
rule as `evaluate: () => null` and a comment saying it would stay unevaluated
"until the shadow record exposes those three numbers in one place". The short
shadow record had shipped two days earlier as `GET /api/journal/short-shadow-record`,
exposing exactly those three numbers and a `gate` verdict on them. Nothing in
the app read it. When the operator asked on 2026-09-18 what the evidence for
shorts was, the answer came from the daily routine fetching the route — the
single point of failure the engine exists to remove. A rule that cannot read its
own criterion is a rule with no criterion; CLAUDE.md's "computed, read by
nothing", one layer up from config.

**The change.**

- `shortShadowRecordData.ts` (new, the DB half): `loadSkippedShorts` (moved out
  of the route; it now reads the WHOLE window with `listAutotradeEventsInWindow`
  rather than the newest 1,000 rows, and reports `journalTruncated`),
  `computeShortShadowReport` (the one compute path the route and the hook
  share), and `refreshShortShadowRecordAfterClose`: once per session after the
  close, replay and persist to the new singleton table `short_shadow_records`.
  One attempt per session — the loop calls it on every after-close tick, and a
  provider outage must cost one evening's refresh, not ~480 replays. The loop
  awaits it right before the gated switches so the engine reads tonight's
  record; a failure is journaled as a stage failure and the engine runs on the
  last record it has.
- `GatedSwitchSnapshot.shortShadow` carries the record's three numbers, its
  `gate` verdict and the session it was computed after. The `shorts` rule reads
  `gate.passes` — the record's OWN verdict, so the rule and the route cannot
  disagree about the bar — and proposes `{ liveAllowNakedShort: true }` with the
  reading as its evidence; it stays quiet once shorts are on.
- `liveAllowNakedShort` is a **proposal-only key**: `SwitchPatch` may name it,
  `assertProposable` (every firing) admits it, `assertWritable` (everything that
  reaches `applied`, and the applier itself) refuses it. And
  `graduationVerdict` now checks the direction BEFORE the stored graduation, so
  a `graduated_at` on an exposure rule's row — hand-edited, migrated or corrupt —
  no longer reads as graduated.
- Every rule may carry a `reading`: its inputs against its bar, in words, met
  or not. Persisted as `gated_switch_state.last_reading` on every evaluation
  (not coalesced — an absent input reads as absent) and shown on the Automatic
  switches card under the rule, so "19 of 30 shadow shorts, avg +0.08R (bar
  +0.1R), win 52.6% (bar 50%) as of 2026-09-18 — short on trades, avg R" is
  visible without fetching anything.
- An EXPOSURE proposal is **pushed** on the session its bar is first met (the
  plan's "reported with the exact settings and waits"), and not again while it
  stays met: the bar, once met, stays met until the operator answers, and a
  nightly push for the same question is how a push stops being read. Safe
  rules' shadow proposals stay journal-only, as before.

**Tested at the consumer.** `gatedSwitchesData.test.ts` persists a record
built by `buildShortShadowRecord` itself (31 declined shorts that fall to their
2R target), runs the engine, and asserts on the stored config
(`liveAllowNakedShort` still false), the `config_change_proposed` row, the one
push, the second session's silence, and the dashboard row's reading; a
19-trade record reads as a reading and no proposal. `shortShadowRecordData.test.ts`
drives the hook through in-session, after-close, same-session repeat, the
route/hook equality and the one-attempt-per-session rule against a provider
that throws.

**Pre-committed check.** The first after-close tick on the deployed box writes
a `short_shadow_records` row for that session, and the Automatic switches card
shows the shorts reading with the same `n`, `avgR` and `winRatePct` the route
returns that evening. On 2026-09-18 those read n 19, +0.08R, 52.6% (the route);
the card must read the same on 2026-09-22 unless new declined shorts moved
them.

## 2026-09-19 (fifth) — the pace floor is re-checked nightly while the flag is on

**The gap.** Pace scoring went on 2026-09-14 with `liveMinSignalScore` raised
72 → 81, the pace-scored floor the ladder re-fit measured as admitting the same
symbols raw-72 did (the section of 2026-09-12 above). `collectScoringShadowFinding`
returned nothing from that moment — "the decision has been taken" — so nothing
asked again whether 81 was still that floor. The equivalence is a property of
the score distribution, which moves with the market's volume shape, and the
operator asked on 2026-09-19 for the check to run nightly.

**What the ladder says now.** Read on the deployed box over the last four
sessions (09-15 … 09-18, 691 loop ticks under the flag): raw-72 admits 24.7
symbols a tick; the pace floor admitting the same is **77.3**; the floor in
force, 81, admits **18.0** a tick — the equivalent of raw-75.3. Friday alone
read 74.8 against 81 (176 ticks, 13.6 admitted against 21.3). The floor has
drifted about four points above its equivalence: the live book sees roughly a
quarter fewer candidates than the fitted floor intended.

**The change.** `paceFloorDrift` (`edgeLeakScan.ts`, pure) runs the same
translation as `equivalentPaceFloor` against the floor in force and returns the
equivalent, the drift in points and both admissions; null off the ladder's ends
rather than a guess. `collectScoringShadowFinding` now branches on the CONFIG's
flag. Off: the pre-enable finding as before, silent when the window holds a row
written with the flag on (a reverted decision is not re-raised). On: it sums
only rows the loop wrote under the flag (a screen route call with the flag
overridden off writes a different distribution) and raises
`configuration:relvol_pace_floor_drift` when the drift is at least
`PACE_FLOOR_DRIFT_POINTS` (2, one rung of the ladder). The reference raw floor is
`PACE_SCORING_RAW_REFERENCE_FLOOR` = 72, a written decision beside the finding
rather than a config value that would follow the floor it judges. The lever is
`liveMinSignalScore` → the equivalent, `direction: 'exposure'` when it lowers the
floor (never the app's to apply: `leak_lever` reads leaks, not findings, and
`exposureGuard` refuses a lower floor besides) and `'safe'` when it raises it,
with the detail asking for a second evening's confirmation either way.

**Tested at the consumer.** The finding over seeded ladders: a floor above its
equivalence (lever 76, exposure), below it (lever 76, safe), inside the bar
(silent), the pre-enable finding never raised while the flag is on, route rows
on raw scoring not summed, a floor off the ladder (silent); and the pure
helper's four cases.

**Pre-committed check.** The first nightly scan after this deploys reports
`configuration:relvol_pace_floor_drift` with a ten-session equivalent in the
mid-to-high 70s and a lowering lever. It is reported and waits: whether to lower
the floor is the operator's decision, and Decision 7's review reads the flow
either way.

---

## 2026-09-19 (sixth) — the re-entry cooldown is measured nightly

**The question.** The operator asked whether `symbolReentryCooldownMinutes`
(390, the whole session — Decision 8 of the 3% plan) could be lowered or the
cooldown done differently, since live trading tends to stop in the afternoon
once the morning's names are locked out, and asked for the paper book to be
read first. It was, along with the live book's own re-entries and the week's
refusals replayed by hand. The decision recorded here is **keep 390, change no
methodology**, and build the instrument that answers the question nightly.

**What the paper book says** (155 closed trades 2026-07-02 … 09-18; no
cooldown, so it is the control for every other gate):

| paper | n | mean R | total R |
| --- | --- | --- | --- |
| round 1 | 93 | +0.079 | +7.33 |
| round 2 | 29 | +0.055 | +1.60 |
| round 3+ | 33 | −0.006 | −0.20 |
| all re-entries | 62 | +0.023 | +1.40 |
| re-entries since 09-14 | 20 | −0.001 | −0.03 |
| round 1 since 09-14 | 27 | +0.257 | +6.93 |
| re-entries before 12:00 ET | 44 | +0.060 | +2.65 |
| re-entries 12:00 and later | 18 | −0.069 | −1.25 |

58 of the 62 paper re-entries were placed within 30 minutes of the previous exit
— the next tick after a stop-out, on the same still-live signal. The paper book
therefore does not model a time cooldown at all: a simulated 60-minute cooldown
leaves 11 re-entries (+0.06R), 120 minutes leaves 6 (−0.16R), 240 minutes leaves
3 (−0.05R). The one paper split that reads positive — re-enter at once after a
LOSER, n=20, +0.24R — is contradicted by the live book below.

**What the live book says** (113 autotrade stock trades 2026-07-09 … 09-18, R
on the journal's own basis):

| live | n | mean R | $ |
| --- | --- | --- | --- |
| round 1, all | 84 | +0.053 | +369 |
| re-entries, all | 29 | −0.174 | −118 |
| re-entries in September (cooldown 90–120 then) | 20 | −0.085 | −128 |
| re-entries 60–120 min after the exit | 12 | −0.091 | −110 |
| re-entry above the prior exit price | 15 | +0.032 | |
| re-entry below the prior exit price | 14 | −0.395 | |
| re-entries since 09-14 (390 in force) | 0 | | |
| round 1 since 09-14 | 14 | +0.098 | |

**What 390 refused this week, replayed.** 1,293 `symbol_reentry_cooldown_skipped`
rows over 09-14, 09-15 and 09-18 (twelve symbol-days; NOW, QCOM and VERA never
reached the 81 floor), replayed with `buildDeclinedEntryShadow` under the
deployed exits (breakeven 0.25R, trail 0.5/0.5, target 1R, stagnation 60 min /
0.5R), entering at the first eligible refusal at or past each gap:

| gap after the exit | n | avg R | total R | winners |
| --- | --- | --- | --- | --- |
| first refusal (0–1 min) | 9 | +0.147 | +1.32 | 6 of 9 |
| 60 min | 9 | +0.049 | +0.44 | 4 of 9 |
| 90 min | 9 | −0.061 | −0.55 | 3 of 9 |
| 120 min | 9 | −0.116 | −1.04 | 0 of 9 |
| 180 min | 9 | −0.091 | −0.82 | 2 of 9 |
| 240 min | 6 | −0.003 | −0.02 | 2 of 6 |

The replay fills at the signal price with no slippage; paired live trades on the
same signals realize about 0.15R less than paper (the scan's attribution, n=35),
so the first-refusal +0.15R is roughly break-even in live terms.

**Why the afternoon is quiet.** 09-16 and 09-17 had no live entries at any hour
— `live_risk_blocked` (over 1,000 rows on 09-17, fixed by PR #629) and the
floor, not the cooldown, since no position existed to cool down. On 09-18 all
five entries came before 11:07; from noon the only names passing the 81 floor
were the four already traded (cooldown rows 108 / 107 / 103 an hour at 12, 13
and 14h; floor skips 0–1 an hour; shorts off 19 / 5 / 1; the entry window closes
about 14:55), and those replay at −0.12R at 120 minutes and 0.00R at 240. The
record's afternoon edge is thin on both books regardless (the scan's entry-hour
dimension); the edge sits in the 09:30–11:30 rounds.

**The gap in the instrument, found on the way.** `GET
/api/journal/declined-entry-shadow` read the newest 1,000 rows (`listAutotradeEvents`,
id DESC, clamped). For a gate that journals once per symbol-day that is the
window; for the cooldown, which journals every tick, it served 09-18, 09-15 and
62 of 09-14's 355 rows and said nothing — the LIMIT artifact of 2026-09-12 one
route over. And the replay could only ask "the first refusal of the day", the
immediate re-entry, never "the first refusal at or past N minutes", which is the
question a shorter cooldown asks.

**The change.**

- The route reads `listAutotradeEventsInWindow` and reports `journalTruncated`;
  `?minMinutesSinceExit=` replays the first eligible refusal per symbol-day at
  or past the gap. `DeclinedEntry.minutesSinceExit` is parsed from the cooldown
  row's own `minutesSince`; rows before the gap are counted `before_min_gap`,
  rows with no gap (other gates) `no_exit_gap`, never passed through. The record
  carries the gap it was replayed at beside its exit rules.
- `reentryShadowRecordData.ts`: once per session after the close, every
  refused symbol-day over the scan's forty-session window (never before
  2026-09-14, when the cooldown went to 390 — the 120-minute era refused a
  different population) is replayed at gaps 0 / 60 / 120 / 180 with one bar
  fetch per symbol-day (`memoCandleSource`) and persisted to
  `reentry_shadow_records`; one attempt per session, awaited by the loop in its
  own try/catch after the short record. `GET /api/journal/reentry-shadow-record`
  serves the stored row.
- `reentryCooldownFinding` (`edgeLeakScan.ts`, pure): a gap SHORTER than the
  cooldown in force with n ≥ `LEAK_MIN_TRADES` and the whole 95% interval ABOVE
  zero raises `configuration:reentry_cooldown_shadow` with the lever
  `symbolReentryCooldownMinutes` → that gap, `direction: 'exposure'` — never
  applied by the app (`leak_lever` reads leaks, not findings; an exposure lever
  never graduates). Among several clearing gaps: the higher mean, the longer gap
  on a tie. Silent inside the bar, without a record, with the cooldown off, or
  when every clearing gap is at or past it. The detail lists every gap's n /
  mean / interval / win rate, says that no paper control exists for a delayed
  re-entry, and carries the window's incompleteness. The scan reads the stored
  record (`collectReentryCooldownFinding`) and stays DB-only.

**Tested at the consumer.** The route over `ROW_CAP + 1` rows (complete, not
truncated) and a three-refusal symbol-day replayed at 120 minutes (that tick's
entry and stop, the earlier two counted); the hook (window start never before
the boundary, one fetch per symbol-day across four gaps, each gap entering at
its own tick's price, once per session, a failure not retried until the next
session, the evidence mapping); the pure finding (named with its lever, every
gap in the detail, below the bar, at or past the cooldown, cooldown off, no
record, tie-break, incompleteness); the DB collector and the end-to-end scan;
the record route.

**Pre-committed check.** The first after-close tick after this deploys writes
`reentry_shadow_records` for that session, and `GET
/api/journal/reentry-shadow-record` reads four gaps over the window since 09-14
with the first-refusal gap the largest n and the 180-minute gap the smallest.
The nightly scan raises **no** `configuration:reentry_cooldown_shadow` finding
on it: no gap is near n ≥ 15 with an interval above zero (the 60-minute gap's
+0.05R on nine trades is the closest). The cooldown stays at 390 until a gap
clears the bar, and then it waits for the operator's word.

---

## 2026-09-21 — the contract-selection overlay was refused for its size, every time

**What happened.** PR #632 (2026-09-19) overlays a real-time OPRA snapshot on
the delayed chain before the options entry rules run, so a contract is chosen on
the price it will actually be bought at. Its first session was 2026-09-21. It
never fired. All **53** `options_signal_generated` rows that day read
`selectionQuoteSource: 'chain'` with `rePricedContracts: 0` beside
`quotesRequested: 40`.

**Root cause, reproduced against the deployed route.** The snapshot endpoint
accepts at most **20** symbols in one call:

```
 2 symbols → ok, 2 quotes
30 symbols → ok:false  "symbols size must be between 1 and 20."
40 symbols → ok:false  "symbols size must be between 1 and 20."
```

`OPTION_QUOTES_MAX_SYMBOLS` was 40, double the limit, and
`selectionCandidates` sized its nearest-the-money set to it. So every request
was rejected whole, `overlaySelectionQuotes` took its `untouched()` path, and
the decision ran on the delayed chain — which is precisely the state the PR
existed to end. A second rule compounds it: the endpoint rejects the ENTIRE
batch with `Invalid Symbol:[…]` when any one symbol is not a listed contract,
rather than serving the ones it can.

**What it cost.** The NVDA 260921C225 bought at 09:51 was selected on a chain
premium of 0.35 and filled at 0.86, about two and a half times the number the
delta band, the spread filter and the risk check all judged. It then went to its
disaster stop. Every options decision since the deploy sized on the same kind of
stale premium.

**Why nothing caught it.** `webullOptionQuotes` is mocked in every test that
exercises the overlay, so the cap was never sent anywhere that could refuse it,
and the one assertion on the number compared the constant to a literal copy of
itself. This is the CLAUDE.md rule in its purest form: a value proven where it is
COMPUTED tells you nothing about the consumer that has to accept it. When a
constant describes somebody else's limit, the test has to be against that limit.

**The change.**

- `WEBULL_SNAPSHOT_BATCH_LIMIT` = 20, the per-call broker limit, separate from
  `OPTION_QUOTES_MAX_SYMBOLS` = 40, the caller cap. Two numbers because they
  answer two questions; a comment on each says which.
- `selectionCandidates` defaults to the BATCH limit, so a decision stays one
  broker call.
- `webullOptionQuotes` chunks its misses into batches of that size rather than
  truncating, and a refused batch no longer discards the batches that answered.
- `SelectionQuoteReport` gains `selectionQuoteError`, journaled with the rest, so
  a fallback to the chain states its reason instead of reading as a quiet market.

**Tested at the consumer.** The request size is asserted against the broker's
limit with its own refusal text in the failure message; every asked-for symbol
reaches a batch (chunking, not truncation); a rejected batch keeps the quotes the
others returned; and the overlay's report carries the broker's own error, the
"nothing fresh" case, and the thrown case.

**Pre-committed check.** The first session after this deploys reports
`selectionQuoteSource: 'opra'` with `rePricedContracts` above zero and
`quotesRequested: 20` on the first options decision that reaches a chain, and
`quoteAgeMs` inside the two-minute freshness window. A `chain` source on every
row again, or any row carrying `selectionQuoteError`, is a finding — quote the
error.

## 2026-09-23 — the protective re-arm sent buy orders, and the kill switch never reached it

**What the operator did.** On 2026-09-21 and 2026-09-22 the operator took over
open positions by hand: engaged the kill switch, changed or cancelled the
app-opened brackets at Webull, and sold from Webull directly. The journal around
those halts, read to reconcile the `live_position_unprotected` alerts that
followed:

```
09-21 10:07:50  live_position_unprotected  LITE  21 held, 0 legs, re-arm refused
09-21 10:07:54  kill_switch_engaged
09-21 10:16–10:18  live_stop_adjust_blocked LITE ×3 (breakeven, no resting leg)
09-21 10:27:40  live_stop_ratcheted  LITE  954.53 → 972.65   ← during the halt
09-21 10:30:39  kill_switch_released
09-22 10:23:03  live_position_unprotected  SNOW  61 held, 0 legs, re-arm refused
09-22 10:28:29  kill_switch_engaged
09-22 10:31:05  live_position_unprotected  SNDK  5 held, target resting,
                re-arm refused "invalid combo_type, value: STOP_LOSS"  ← during the halt
09-22 13:34:36  kill_switch_released
```

The missing stops were the operator's own doing, so those alerts were not lost
orders. What the timeline also shows is the app acting on the account after
the switch was engaged. Reading why turned up four defects, the first worse
than the alert it was attached to.

### 1. Every automatic re-arm of a long was a BUY stop and a BUY take-profit

`buildStandaloneBracketRequest` takes the position's **entry** side (buy for a
long) and `bracketExit` flips it, so the legs rest on the closing side. The
scale-out's rollback and the manual `POST /live/standalone-bracket` route both
passed `buy`. The protection sweep's re-arm, shipped 2026-09-12, passed the
**closing** side, `sell`, which `bracketExit` flipped again. Every re-arm it
sent for a long was a BUY stop at the recorded stop plus a BUY take-profit
limit at the target.

The broker refused every one. Three refusals read *"The stop price of the
stop-loss order should be higher than the current market price"*, which is the
broker's rule for a **buy** stop. On 2026-09-15 that wording was read as "the
stop is already through the market" (see that day's section, now corrected).
The minute bars say otherwise:

| Refusal | Recorded stop | Price at the minute |
| --- | --- | --- |
| BWIN 2026-09-14 12:13 | 31.16 | 31.95 |
| LITE 2026-09-21 10:07 | 954.53 | ~964 |
| SNOW 2026-09-22 10:23 | 334.28 | ~338.5 |

Price was above the stop each time, where a correctly-sided sell stop is an
ordinary order. The fourth attempt, SNDK, failed for the reason in (3).

**The refusals were the lucky half.** A naked long trading **below** its stop
makes that buy stop valid, and the buy take-profit limit, resting above the
market, is marketable. The "protection" would have bought the position again
at the worst moment. It never happened: all four refusals were at prices where
the buy stop was invalid. SNOW, taken over by hand on 09-22, was 1.3% above its
stop when the attempt was made.

The correctly-sided order is proven. The scale-out's cancel-replace placed the
same standalone pair with `buy` as the entry side eleven times from 2026-09-08
to 2026-09-11, and the broker accepted all eleven.

### 2. The kill switch reached none of the three direct broker calls

The kill switch lives in the guardrails (`buildLiveTradingConfig` ORs both
switches into a blocking rule), and three order paths call the broker without
going through them:

- the **re-arm** (`webullPlaceStandaloneBracket`). Its doc comment said it
  went through the guardrails "which fail `kill_switch`". Only the breach close
  does. SNDK's re-arm reached the broker at 10:31:05 on 09-22, 2½ minutes into
  the halt;
- the **stop ratchet** (`webullReplaceOrder`). "Reducing risk, so no entry
  gate", and the gate it lacked was the kill switch too. It moved a LITE stop
  at 10:27:40 on 09-21, twenty minutes into the halt. No LITE stop rested from
  10:07 to 10:18, so the leg it moved was very likely one the operator had just
  set;
- the **scale-out's bracket resize** (`webullReplaceOrders`, and the
  cancel-replace fallback). The partial sell after it runs the guardrails and
  was always refused under a halt. So a halted account would have had its
  bracket cut to the remainder, then nothing sold, leaving the partial without
  a stop. The scale-out is off in production, so this never happened.

The User Guide promised the opposite: an engaged kill switch "freezes **all**
automated live order placement — exits included … the right tool for 'hands
off, I'm trading this account manually in Webull'".

### 3. The stop-only re-arm could never be accepted

When the take-profit still rested and only the stop was gone, the re-arm placed
a stop **alone**, so as not to stack a second take-profit. The broker counts
shares held **minus** shares already committed to resting exits
(`committedProtectiveQuantity`, measured on FCX 2026-09-08), and the
take-profit commits all of them. No stop of any size fits under it. SNDK's
refusal is that rule. A lone stop, had it been accepted, would also have left
an orphan: not linked to the old take-profit, so a stop fill left a GTC sell
resting over shares no longer held.

### 4. The ratchet decided against the ledger, not the resting stop

`evaluateStopAdjust` compares its next step with the position row's stop, and
the ledger never sees a stop moved by hand at the broker. A stop the operator
had raised past the app's next step would have been pulled back down to it.

### Why nothing caught it

Three tests asserted the re-arm's intent, `side: 'sell'`, which reads like
"sell to protect a long" and was the bug. The kill-switch test asserted that
the **close** was stopped, which it was, and never asserted that the re-arm
above it was not called. It is the same lesson as 2026-09-21's batch cap: a
value checked where a caller builds it proves nothing about what the consumer
receives. These tests now run the intent through the real request builder and
assert the side on the wire.

### The change

- **`protectiveBracketIntent(symbol, positionSide, quantity)`** in
  `providers/webull/orders.ts`, the one derivation of a protective bracket's
  intent. The re-arm, the scale-out's rollback and the manual route all call
  it.
- **The protection sweep reads the kill switch** (either page's) before it
  places or cancels anything. While a switch is engaged it still detects and
  pages once a day, with `heldByKillSwitch: true` and a reason that says so,
  and it places, cancels and closes nothing. On the first sweep after release,
  a position still naked is re-armed.
- **It never places over an app close already working**
  (`exitWorking: true`). A timed exit's marketable limit reads as a
  take-profit, so the sweep could otherwise cancel the app's own close.
- **Stop gone, take-profit resting:** the take-profit is cancelled
  (`live_bracket_rearm_target_cancelled`, not paged), and the next sweep,
  finding nothing resting, re-arms both legs as one OCO pair. A failed cancel
  pages with the broker's reason, and a leg the sweep cannot classify is never
  cancelled. None of these count as the broker refusing a stop, so none of
  them can trigger the breach close.
- **The ratchet holds under a kill switch.** It journals
  `live_stop_adjust_held` once per position per day and makes no broker call,
  but it still records the water mark, which is bookkeeping rather than an
  order. It also **never loosens the stop actually resting**: when the leg
  carries a stop price at or past the move, it journals
  `live_stop_adjust_skipped` once a day and leaves the stop alone.
- **The scale-out holds under a kill switch** before its resize.

Every call on the autotrade path that places, modifies or cancels an order now
passes either the guardrails or this check: entries, scale-ins, per-lot second
lots, timed exits, the breach close and every options order through the
guardrails; the options chase through its own switch check; and the re-arm,
the take-profit cancel, the ratchet and the scale-out through this one. Under a
halt, the app places, moves and cancels nothing, which is what the User Guide
promised and is now true.

### Pre-committed check

- The next `live_bracket_rearmed` row on a long is the first re-arm this app
  has ever placed on its own. It must carry `legsPlaced: 'stop+target'`, and
  the broker's order history must show two SELL legs. A refusal on a long
  worded "…should be higher than the current market price" is a finding: that
  is the buy-stop rule, and it means the side is wrong again.
- Between any `kill_switch_engaged` and its `kill_switch_released`, the journal
  must carry no `live_bracket_rearmed`, `live_bracket_rearm_target_cancelled`,
  `live_stop_ratcheted`, `live_scale_out_placed` or `live_time_exit_placed`
  row, and any `live_position_unprotected` row in that window must read
  `heldByKillSwitch: true`.

## 2026-09-23 (second) — a close the order lists never showed

**What happened.** SHOP (position 686, 91 shares) hit its stagnation exit at
15:27:55 on 2026-09-22. The close was accepted (intent 35974, broker order
`80HAQQC9TKE99E2ADV2CQPD45B`), and by 15:28:31 the broker held no SHOP
(`position_quantity_drift`, broker 0 against journal 91). The intent never
moved past `acknowledged`. The broker sync, which defers to a close the app has
in flight, deferred at every sync (`autotrade_exit_in_flight`, marked overdue at
streak 10). The end-of-day flatten then tried to sell again and was correctly
refused as a naked short, three times. At 21:40 ET the position was still open
in the ledger, holding one of three concurrency slots, with its gain unbooked.
MU's close at 15:54 took the same path and was booked in two minutes.

**Why.** The order reconcile reads status from the two order lists only: open
orders, then history. An acknowledged order missing from both was "left alone"
by design, on the reasoning that it might have aged out of the history window,
and nothing was journaled. Webull's reference says of **both** lists: *"This
endpoint may not return the most recent order data in real time due to
processing delays. To ensure you get the latest order status, please query the
Order Detail endpoint by client_order_id."* The Order Detail endpoint appears
in this app's rate-limit table and in the design doc's endpoint list
(`LIVE_TRADING_DESIGN.md` §14: "we'll poll Order Detail / Open Orders
instead"), and nothing ever called it.

**The change.**

- `webullOrderDetail(accountId, clientOrderId)`:
  `GET /openapi/trade/order/detail` with `account_id` and `client_order_id`.
  The contract comes from Webull's current SDK (`webull-openapi-python-sdk`,
  `OrderDetailRequest`, "supported only for Webull HK and Webull US"). The
  response shape is undocumented, so it is parsed exactly as a list entry is,
  and a reply that does not name our `client_order_id` reads as not found,
  never as a guess.
- `reconcileLiveOrders` asks it about every `acknowledged` or
  `partially_filled` order that neither list accounted for, whether the list
  missed it or the list read failed. It asks about at most
  `ORDER_DETAIL_LOOKUPS_PER_TICK` = 3 a tick, newest first, because the
  endpoint is paced at 2 requests / 2 seconds and an order long aged out of the
  lists must not starve a fresh one. A found answer feeds the same
  `reconcileOneLiveOrder` a list answer does. Nothing new places, cancels or
  modifies anything.
- A late-booked close is **dated by its order**, not by the booking.
  `materializeTimeExitFill` used today's date, which was right only while every
  fill was seen on the day it happened. Every order it books is a DAY order,
  which can fill only on the date it was placed, so that date is the fill
  date. Otherwise SHOP's 09-22 gain would have landed in 09-23's day P&L, which
  the halts, the goal and the give-back guard all read.
- Two journal rows, each once per order per day: `live_order_status_from_detail`
  (resolved by the direct read, with what the list read said) and
  `live_order_status_unresolved` (neither read found it). The unresolved row
  carries the direct reply's **keys**, never its values, so the first real
  answer documents the undocumented shape.

**Tested** with a stubbed transport: the request's path and query, an envelope,
an array of envelopes, a reply naming another order (not found), and a failed
read ("could not ask"). In the reconcile, the SHOP sequence end to end: a time
exit placed, then both lists silent, then the direct read reports FILLED. The
position closes at the reported price with one `live_order_status_from_detail`
row, and a close first read a day late keeps its placement date. Also tested: a failed list read, an unresolved order (no change, one row
a day, the reply's keys), the per-tick cap newest-first, and that an order the
lists answered costs no direct read.

**Pre-committed check.** On the first reconcile tick after deploy, intent 35974
is looked up directly. Expected: `live_order_status_from_detail` for SHOP with
`status: 'FILLED'` and `listRead: 'not_found'`, and position 686 closed with
exit date 2026-09-22 at the
broker's fill price, at or above the 147.61 marketable limit (priced 0.5% under a
last of about 148.35). If the row is `live_order_status_unresolved` instead, its
`detailShape` is the finding: the reply is shaped differently from a list
entry, and the parser is fixed from that shape before anything else. If
neither row appears, the reconcile never reached the order, which is a finding
too.

**Result (2026-09-22, 22:36 ET, first reconcile after the deploy).** As expected.
`live_order_status_from_detail` for SHOP, intent 35974: `status: 'FILLED'`, 91 filled
at 148.34, `listRead: 'not_found'`. Position 686 closed at 148.34 with exit date
2026-09-22 and +$123.76. The fill was above the 147.61 limit. The 09-22 daily result
includes it: −$382.96 over 11 closes (8 stock, +$5.04 net, and 3 options, −$388.00),
recomputed by hand from the positions and matching the stored row to the cent.

## 2026-09-23 (third) — the halt the review counts was never recorded

Found while re-reading the 09-22 daily result. Three defects share one root: a
consumer waiting on a record no producer writes. None has cost anything yet. The
journal holds no live halt, no give-back halt and no unknown order outcome in 45 days.
Each would have hidden the next one.

**1. The daily results row could never say the live book halted.** The recorder wrote
`drawdownHalted: existing?.drawdownHalted ?? false`, and nothing anywhere had ever set
`existing` true. The backfill wrote a hard `false`. The sizing review reads that column
for Decision 7's second revert condition, "the drawdown halt tripped twice in any 5
sessions" (`sizing_revert` in `gatedSwitches.ts`), so that half of the rule was dead.
Its test passed throughout, because it handed the review hand-built rows with
`drawdownHalted: true`, a shape the recorder could not emit. This is the `goalBasis`
lesson of 2026-09-16 again, one column over.

**2. The halt alert watched a halt nobody runs.** It judged live stock and live options
as separate pools, each against the level. Both live risk checks halt on the **sum**:
`liveExecute.ts` adds the options seed to its snapshot, and `liveOptionsExecute.ts` adds
the stock snapshot to its own. So a day losing $1,500 on stock and $700 on options
against a $2,000 level halted every live entry and pushed nothing. Options alone at
−$2,100 on a +$500 stock day pushed "new live options entries are blocked", which was not
true.

**3. The edge-leak scan's execution catalog listed three names nothing writes.**
`daily_drawdown_halt` is the guardrail rule's name and was never journaled as an action.
The give-back writer says `daily_give_back_halted`, not `give_back_halt`. The
unknown-outcome writers say `live_order_outcome_unknown` and
`live_options_order_outcome_unknown`, not `live_order_unknown_outcome`. The reachability
guard (`journalActionsReachability.test.ts`) exists to catch exactly this and did not.
Its emit scan counts every `action: '…'` line as a write, and the catalog writes its
entries that way, so the catalog vouched for itself. The guard's own comment warned about
a dead filter "vouching for itself" and guarded two other forms of it.

**Changes.**

- `dailyHaltMarker.ts` (new, a leaf) owns the marker's one writer and one reader. The
  action name stays `daily_halt_alerted`, so the once-a-day throttle still sees markers
  written before the change. The detail now carries `dailyPnl`, `haltLevel` and, for
  live, `stockPnl` and `optionsPnl`.
- The alert has two pools. `paper` is unchanged. `live` is `liveDailyPnl +
  liveOptionsDailyPnl`, the figure the live checks compare, and its message names each
  sleeve's share.
- The recorder sets `drawdownHalted` from a `live` marker for that date, OR the stored
  flag, so a re-record never clears a halt. The backfill reads the marker too. A paper
  marker never counts, and nor do the legacy `liveOptions` markers.
- The catalog reads `daily_halt_alerted` split by pool (live and paper are separate
  findings), `daily_give_back_halted`, and both `…_order_outcome_unknown` actions.
- The guard skips `action:` keys inside a `const X = [...]` catalog. Against the old
  catalog it now fails with exactly the three names above.

**Tested at the consumer.** An end-to-end case records ten sessions with the real
recorder, two of them carrying a live marker written by the alert's own writer, and
asserts that the gated-switch snapshot reads `haltsMaxIn5: 2` and that `sizing_revert`
fires with "2 drawdown halts in 5 sessions" as its evidence. It fails against the old
recorder line. The same ten sessions with paper markers fire nothing. The alert cases
now cover the split halt (stock −1,800 and options −1,300 against −3,000, one live
alert) and the options-only non-halt (no alert). The leak-scan case counts a halt
written by the real writer, under both pools.

**Pre-committed check.** The next day the live book's realized P&L reaches the halt level,
three things must happen. One `daily_halt_alerted` row with `pool: 'live'` and both
sleeve figures. That session's daily results row showing `drawdownHalted: true` (an H on
the calendar). The next edge-leak scan listing `daily_halt_alerted|live` among its
findings. If the alert fires and the row still reads false, the recorder is not reading
the marker for that date. That is the finding, and nothing else is read until it is
fixed.

## 2026-09-23 (fourth) — the options reconcile asks Order Detail too

Task #87, the follow-up the SHOP fix promised. The options reconcile read the same
two order lists as the stock one and had the same blind spot. An acknowledged order
that neither list showed fell to the `!found` branch and was left alone.

**Why it cost less here, and what it still cost.** The stock sync deferred to the "exit
in flight", so SHOP stayed open all evening. The options broker sync does not defer. It
closes a contract Webull no longer holds on its second consecutive miss
(`MISS_CONFIRM_THRESHOLD` 2). But it books the close at an **estimate** from the delayed
chain, with exit reason `manual` and `via: 'broker_sync'`. So a filled options close the
lists missed lost its real fill price, and it lost the rule that fired, which is what the
options ladder is judged by. Four closes on 09-21 and 09-22 went through that path:
TSLA #11, INTC #10, GOOGL #13 and AAPL #12. GOOGL's estimate equals its entry exactly
($0.00). Both days include the operator's hand closes under the kill switch, which only
that path can book. OPTIONS_TUNING_PLAN's data-quality notes carry the row.

**Changes.**

- `orderDetailFallback.ts` (new) holds the Order Detail lookup that #637 wrote inside
  the stock reconcile, moved unchanged: same candidates, the same cap of three a tick
  newest first, the same once-a-day rows. Both reconciles call it, with a `book`
  argument that picks the journal names. The options rows are
  `live_options_order_status_from_detail` and `live_options_order_status_unresolved`.
- The options reconcile runs before the broker sync in every tick, so a close Order
  Detail can see is booked at its fill with its own reason before the sync's second miss.
  The sync's estimate remains the path for a contract that leaves the account without an
  app order: a hand close in Webull.
- A late-booked options close carries its order's date. `optionsExitAt` returns the
  placement moment when the reconcile books a fill on a later ET date than the order was
  placed. Options orders are DAY orders (`buildWebullOptionOrder`), and a DAY order fills
  only on its placement date. Same reasoning as the stock time exit's `exitDate` (#637).
- Both `…order_status_unresolved` actions (stock and options) are now in the
  ambiguity push alert (`AMBIGUITY_ACTIONS`) and in the edge-leak scan's execution
  catalog. Before this, the state that held SHOP open was journaled but alerted nobody.

**Tested at the consumer.**
- A filled close the lists never showed is closed at the Order Detail price with the
  reason on its order row (`time_exit`), with one `…from_detail` row.
- Run in the loop's order twice against a broker holding nothing, reconcile then sync,
  exactly one close lands, and it is not a `broker_sync` estimate.
- An order no read can find is journaled once across two ticks and the position stays
  open.
- An order the lists did answer costs no direct read.
- A close first read on a later day carries its order's placement moment.
- Four of these fail with the options call removed. The stock SHOP cases pass unchanged
  after the move.

**Pre-committed check.** Two things, whichever comes first:
- The next options close whose order neither list shows must journal
  `live_options_order_status_from_detail` and close at the broker's fill price, with no
  `broker_sync` row for that position.
- The next `live_options_order_status_unresolved` must reach the ambiguity push within
  the hour.

A `broker_sync` close of a position that still has an acknowledged app exit order is a
finding. It means the direct read did not find that order, and the unresolved row says
why.

## 2026-09-23 (fifth) — a confirmed fill replaces a broker-sync estimate

Found while checking what the four broker-sync estimates of 09-21 and 09-22 had cost.
One of them was not a hand close. GOOGL #13's take-profit (intent 35962, sell 5 at a
$2.55 limit, 09:49:40) filled at an average **$2.57**. The broker sync closed the row
first, on its second miss, at a $1.55 estimate labelled `manual`. That is the entry price
exactly, so the trade read $0.00. When the reconcile later saw the order FILLED,
`closeLiveOptionsPosition` returned null because the row was already closed. The
reconcile marked the fill materialized and dropped it. The day's strategy result read
**−$382.96**. With the real fill it is **+$127.04**, a green session recorded as red.

The Order Detail lookup of "(fourth)" makes this race rarer. It cannot make it
impossible: the positions read can still see a close before any order read does.

**Change.** `correctEstimatedOptionsCloses` runs at the end of every options reconcile.
It lists filled exit orders whose position is closed (last seven days). It rewrites the
position's exit to the order's confirmed fill (materialized notional ÷ quantity), with
the reason on the order row, and clears any short-leg estimate. It acts only when all of
these hold:
- exactly one filled exit order links to the position;
- that order's materialized quantity is the whole closed quantity;
- the recorded exit disagrees with it (price by half a cent, a short-leg estimate, or the
  reason).

A close the reconcile booked itself already agrees and is never rewritten. A hand close
in Webull has no app order and keeps its estimate. Each correction journals
`live_options_exit_corrected` (before and after price, reason and P&L). It is also a
leak-scan execution finding, because the race happening at all is the defect. A
correction to a past date re-records that day's daily result, if one exists, keeping its
account half. The day's own row is re-recorded by the loop after the close anyway.

**Tested at the consumer**, through the real paths: a close in flight, the sync booking
its estimate on the second miss, then the lists catching up with the fill. The estimate
becomes the fill with the order's reason, and one correction row carries (5 → 4.75,
`manual` → `time_exit`, $400 → $350). Also tested:
- a close the reconcile booked itself is never rewritten;
- a hand close is left alone;
- two filled exits for one position stand the correction aside;
- a past date's daily result is re-recorded with its account half kept.

Both rewrite cases fail with the call removed. The "(fourth)" test of the loop's order
now runs against positions the sync genuinely considers: the fixture had no account id,
so the sync had skipped them and the "no broker_sync row" half of that test was vacuous.
It now fails on the estimate when the Order Detail call is removed.

**Pre-committed check.** On the first options reconcile after the deploy there must be
exactly one `live_options_exit_corrected` row, for position 13: from $1.55 `manual` to
$2.57 `take_profit`, P&L $0.00 → +$510.00. After it, the 2026-09-22 daily result must read
a strategy P&L of +$127.04 over 11 closes. Any other position corrected is a finding: read
its intent before trusting the new number. MU #14, NVDA #9, TSLA #8, COIN #7 and HOOD #6
were closed by the reconcile at their fills and must not move.

## 2026-09-23 (sixth) — a hand close books the broker's fill

The three estimates "(fifth)" left alone were the operator's hand closes under the kill
switch: INTC #10 and TSLA #11 on 09-21, AAPL #12 on 09-22. No app order exists for them, so
nothing app-side knows their price. The broker does. Its order history lists every fill of
the last seven days. A single-leg option order names its contract on its leg (`option_type`,
`option_expire_date`, `strike_price`, `symbol` = the underlying) and carries
`position_intent` (`SELL_TO_CLOSE`), `filled_price`, `filled_quantity` and
`filled_time_at`. That is the shape the app's own NVDA close came back in, on 2026-09-21.

INTC is the size of the problem. The 0DTE $119 call (5 contracts at $0.84) was booked at
**$1.29** at 12:46 ET. The app's own chase had priced it at a **$3.70** bid two minutes
earlier (its 24 refused closes from 11:52 to 12:44 were the operator's resting sell in the
way), and INTC stood about $3.50 in the money. At a ~$3.70 fill the trade is about +$1,430,
not +$225, which moves 09-21's strategy result from −$1,160.36 to roughly flat.

**Changes.**

- `listBrokerOptionFills` / `parseBrokerOptionFills`: every single-leg options fill in the
  history, from one paged read. Equity orders, unfilled orders, spreads and unparseable
  contracts are skipped. A partial fill that was later cancelled counts, because those
  contracts traded.
- `matchHandCloseFill` (pure) takes SELLs of the exact contract, at or after the position
  opened, that are not one of the app's orders (`intentExistsForKey`). It adds them oldest
  first until they reach exactly the position's quantity and books the quantity-weighted
  price at the last fill's time. An overshoot or a shortfall stays an estimate.
- The broker sync asks the history (one read, only when it is closing something) before it
  estimates. The estimate is now the real-time OPRA mid when fresh, else the chain. The
  journal row's `pricedBy` says which (`broker_fill`, `opra`, `chain`). Spreads are
  unchanged.
- `correctHandClosesFromHistory` runs after the sync, at most every 15 minutes. It reads the
  history only while an estimated hand close is unconfirmed in the last seven days. It
  rewrites each match (price and exit time, reason still `manual`), journals
  `live_options_exit_corrected` with `source: 'broker_history'`, and re-records each past
  day the move touched.
- The comment on `safeContractMark` said its price was only for display. That was false: it
  is the booked exit. The comment is corrected.
- Correction rows now carry a `source`, and the leak scan splits on it. `app_order` (the
  race in "(fifth)", an app defect) and `broker_history` (a hand close re-booked at the
  operator's fill: context, not a defect) are reported separately.

**Tested.**
- The parser runs on the exact envelope the history returned for NVDA, with its fallbacks
  and skips.
- The matcher is tested on:
  - a single fill;
  - a quantity-weighted pair;
  - exclusions (app orders, other strikes, expiries, types, sides, underlyings, and fills
    before entry);
  - an overshoot and a shortfall;
  - a spread.
- The sync is tested on each source: a history fill (booked at its price and time, and read
  once), the OPRA mid, and the chain.
- The pass is tested on an INTC-shaped correction, $1.29 → $3.70, P&L +$90 → +$572, and on
  the 15-minute throttle and the no-read-once-confirmed rule. An Auto-page close (manual,
  but via an app order) is never a candidate, and a past day's result is re-recorded.
- Four cases fail with the match removed.

**Pre-committed check.** On the first pass after the deploy (within 15 minutes), INTC #10,
TSLA #11 and AAPL #12 must each carry a `live_options_exit_corrected` row with
`source: 'broker_history'` and the broker's fill, or have a stated reason why not. The
reasons that count are that no matching sale is in the history, or the sales do not add up to
the position. If the first two correct, 09-21 and 09-22 are re-recorded. A hand close that
stays at an estimate with a matching sale in the history is a finding.

**Result (2026-09-23, 03:59 ET, the first pass after the deploy).** All three corrected,
each to one hand sale in the history. Hand orders do appear in the OpenAPI history; their
`client_order_id` is 24 hex characters, while the app's own are 32.

| Position | Booked at | The operator's fill | P&L before → after |
| --- | --- | --- | --- |
| INTC #10 (09-21) | $1.29 | $3.55 at 12:44:28 | +$225 → +$1,355 |
| TSLA #11 (09-21) | $1.38 | $1.58 | −$44 → −$4 |
| AAPL #12 (09-22) | $0.94 | $0.62 | −$176 → −$432 |

Both days were re-recorded: **09-21 +$9.64 (+0.03%)**, from −$1,160.36, and **09-22
−$128.96 (−0.46%)**, from +$127.04.

## 2026-09-23 (seventh) — a stock bracket exit books its leg's fill

The same race as "(fifth)", on the stock side, and it moved live sizing. When a bracket leg
fills, two things try to book it. The entry order's reconcile reads the leg from the order
lists, which show a filled leg about **2m15s** late (USDE's stop 2m13s, GRML's target
2m18s). The position sync sees the shares gone. After `MISS_CONFIRM_THRESHOLD` (2) +
`BRACKET_RECONCILE_GRACE_SYNCS` (2) misses it prices the close itself, at a live quote, with
a reason inferred from the levels or `manual` between them. Whichever writes first is the
record: the sync's close takes the entry order out of the pending list, and its reconcile
never looks at the leg again.

The grace was a count, and two callers bump the same streak: the loop's own sync every tick
and the background scheduler every 60 s. So four misses took **2m11s** for COIN on 09-21:

```
09:41:48  COIN STOP_LOSS leg FILLED 161 @ 204.37  (breakeven stop; entry 204.39) → −$3.22
09:43:01  INTC closed from its fill, 'stop', −$1.83
09:43:59  position_reconciled_from_broker COIN 161 @ 205.0451, 'manual' → +$105.47
09:44:03  HPE entered at full size (251 sh, risk ~$522); stopped out 10:13, −$429.21
```

The step-down counts consecutive losing trades off these rows. With COIN booked correctly,
INTC and COIN were two losses in a row at 09:44, and HPE would have gone in at half size
(about −$214). The same race booked COIN #651 and HOOD #650 on 09-18 (targets, at quotes
above the target prices) and LITE on 09-21 (a stop, at a quote).

The repair already existed and was never run. `services/exitPriceBackfill.ts` decides a
correction from the entry's combo, and `npm run backfill:exits` applies it. It was written
as a one-shot for a parser bug that was supposed to be the last source of these rows, and
nothing re-ran it.

**Changes.**

- `webull_miss_streak.first_missed_at` records when the current run of misses began. The
  bracket defer holds until both the count is spent and `BRACKET_RECONCILE_GRACE_MS`
  (**4 minutes**) has passed since the first miss. The defer row carries `closesAfterMs` and
  `missingSince`. The cost is a dead position holding its slot a little longer when no
  reconcile ever books it. The `STUCK_DEFER_STREAK` comment said twenty minutes; with two
  callers it is about five, and the comment now says so.
- `correctEstimatedStockExits` (`stockExitCorrection.ts`) runs in the loop after the stock
  sync. It asks about a new estimate on the next tick and about the rest at most every
  15 minutes, only while an estimate exists in the account within the history's seven days.
  It reuses `decideExitCorrection` unchanged in what it will act on: one filled exit leg
  whose quantity matches the booked one. The decision now also returns the reason the leg
  proves (`legExitReason`: the stop leg is `stop`, the take-profit is `target`, never a
  guess from the price). An estimate that landed on the fill but says `manual` for a stop
  is corrected too.
- Each correction rewrites the price and the reason (`correctExitPrice` takes an optional
  reason), journals `live_exit_corrected` (`source: 'bracket_leg'`, before and after price,
  reason and P&L), and re-records the past day it moved. It is a leak-scan execution
  finding: a race the app lost.
- **A hand sale books the operator's fill.** A combo the broker is done with that has no
  filled exit leg is a hand close: the operator cancelled the bracket and sold. The time floor
  makes its quote up to four minutes later than the sale, so it is matched instead:
  `listBrokerEquityFills` (one paged history read, only when such a close exists) and
  `matchStockHandSale` (pure, the twin of `matchHandCloseFill`). A match is a plain SELL of the
  symbol since the entry, not an app order, and sales are added oldest first until they reach
  exactly the booked quantity. The reason stays `manual`, and the row says
  `source: 'broker_history'`. An unmatched hand close is asked about through the day of the
  close, because the history lags, and is final after that. A combo that aged out of the
  history is final too. A failed read is retried.
- The live reconcile names a filled leg with the same `legExitReason`, so a first booking
  and a correction cannot disagree. The CLI and the loop share one candidate query
  (`listSyncEstimatedExits`), and the sync's estimate note is built from the prefix that
  query matches (`SYNC_ESTIMATE_NOTE_PREFIX`).

**Tested.**
- **End to end at the consumer.** The real sync books COIN at a $205.0451 quote after its
  grace, and the live snapshot reads `consecutiveLosses` 0. The pass then corrects it to
  $204.37 `stop` (−$108.69), and the same snapshot reads **2**.
- **The race.** Six misses 30 s apart leave the position open. It closes at the time floor.
  Both this case and the grace case fail with the time floor removed.
- **The pass.** A new estimate is read at once, the rest every 15 minutes. A finished combo
  with no filled leg, and a combo that aged out, are not re-read; a failed read is.
  Another account and rows older than seven days are never read. A past day is
  re-recorded with its account half kept.
- **The decision.** The COIN correction, a reason-only correction, a target leg, and
  `legExitReason`'s labels.
- **Hand sales.** A cancelled bracket plus the operator's sale books the sale, reason kept
  `manual`. An unmatched one is re-asked through its day, then final. A working bracket, or
  one whose leg filled, never reads the stock history. The matcher is tested on a single
  sale and a weighted pair, on every exclusion (buys, other symbols, sales before entry,
  bracket legs, app orders), and on an overshoot and a shortfall. The parser is tested on
  the history's own envelope shapes.
- Dropping the reason from the correction fails the end-to-end case.

**Pre-committed check.** On the first pass after the deploy, `live_exit_corrected` must
correct **COIN #656 (09-21) to $204.37 `stop`** (P&L +$105.47 → −$3.22). 09-21 must then
be re-recorded at +$9.64 − $108.69 = **−$99.05**, plus LITE's own correction, which is
unknown until its leg is read. COIN #651, HOOD #650 (09-18) and LITE (09-21) must each
be corrected to their leg's fill or have a stated skip. The hand closes of 09-22 (MRVL,
SNOW, MRNA, SNDK) must be corrected to the operator's own sales with
`source: 'broker_history'`, reason still `manual`, or have a stated skip. The only skip that
counts is sales that do not add up to the booked quantity. From the first session
after the deploy, a `position_reconcile_skipped` row for a bracketed position followed by a
`live_position_closed` from the reconcile, not a `position_reconciled_from_broker`, is the
race going the right way.

**Result of the first deploy (2026-09-23, 00:38 ET): nothing corrected, and the check
caught why.** The candidate query required `positions.source_intent_id`. Every live stock
position on the deployed book is **adopted**: the broker sync imports the fill before the
reconcile materializes it, so `source_intent_id` is NULL and the entry order row points at
the position instead. All eight estimates (COIN #651, HOOD #650, COIN #656, LITE #661,
MRVL, SNOW, MRNA, SNDK) were invisible to the pass. The tests passed because their fixtures
set `source_intent_id`, a shape production does not have. This is the third time the same
blind spot has shipped: the first two are recorded on `entryIntentIdForPosition` (an adopted
CTVA position's time exit failing 21 ticks running, and the protection alarm silent for ten
days). The fix resolves the entry order through that same function, in the pass and in the
CLI. The query accepts either link, and the fixtures now use the adopted shape by default.
With the old query restored, seven cases fail.

## 2026-09-23 (eighth) — a refusal the journal records once a day stands for that day

The leak scan's attribution files every paper entry the live book did not take under the
live journal's own word for the skip, read within the minute of the paper entry. What it
cannot find goes to `no_live_row`, "nothing the journal explains". On the deployed book
(40 sessions, read 2026-09-23 at 03:55 ET) that was the largest untaken class by far:
**85 entries, paper +7.07R**, beside 42 paired trades. It was also the evidence read for
the pending question of lowering the live floor (81 → 77, an exposure change on the
operator's word).

Most of it was a writer's throttle, not a hole in the record. The declined-entry path
journals through `journalEntrySkipOncePerDay`: one row per symbol per action per ET day.
The live floor refuses NVDA at 09:40 and writes its row, then refuses it silently on every
later tick. Paper, whose floor is 60, takes NVDA at 11:00. The classifier found no row
within a minute of 11:00, so a gate doing exactly its job read as "unexplained".

**Change.** After the same-minute match and the tick's batch refusals, `classifyUntaken`
falls back to that symbol's latest once-a-day refusal made the same ET day, at or before
the paper entry (`ONCE_PER_DAY_SKIP_ACTIONS`). These are the score floors, the symbol
cooldown, the ATR, absorbed-price and unplaceable gates, a symbol already held, the finish
line, and the short skip. The re-entry cooldown and the risk check journal on every tick,
so an earlier row of theirs never stands in: their silence at 11:00 means they had stopped
refusing.

**Tested.** A 09:40 floor refusal files an 11:00 paper entry, and with two standing
refusals the latest wins. An earlier every-tick refusal, a refusal from another day or after
the entry, and another symbol's refusal all leave it `no_live_row`. A same-minute refusal
and the tick's batch refusal still win over the standing one. The action set is checked
against the source: every literal action `journalDeclinedEntry` receives in
`liveExecute.ts`, and every action the score gate can return, must be in it.

**Pre-committed check.** On the first scan after the deploy (the evening routine's, or
`GET /api/journal/edge-leaks?sessions=40&book=both`):
- the untaken total must be unchanged: the same trades, with different labels;
- `no_live_row` must fall below 85;
- what leaves it must land in once-a-day classes, mostly `live_score_floor_skipped`.

If `no_live_row` does not fall, the writer is not the cause and the bucket needs a
different explanation. The floor question itself stays the operator's: the re-labelled
bucket is the evidence for it, not a lever the app pulls.

**Result of the deploy (read 2026-09-23, 00:59 ET).** Two of the three checks held. The
prediction behind the third was wrong, and the way it was wrong is useful.

- The untaken total is unchanged: 134 entries and paper +11.78R, before and after.
- `no_live_row` fell from 85 to 53 (paper +7.07R → +4.42R).
- All 32 entries that left it landed in once-a-day classes, but not mostly in the floor:

| class | before | after | paper R of the entries that moved |
| --- | ---: | ---: | ---: |
| `risk_atr_unreachable_skipped` | 1 | 11 | +3.25R (+0.33R each) |
| `live_score_floor_skipped` | 3 | 12 | +0.74R (+0.08R each) |
| `live_short_skipped` | 6 | 15 | −0.88R (−0.10R each) |
| `symbol_cooldown_skipped` | 1 | 3 | +0.13R |
| `live_symbol_held_skipped` | 0 | 2 | −0.60R |

The prediction named the floor because the floor was the question on the table. The ATR
reachability gate (`maxRiskAtrFraction`) took the most entries and nearly all of the R.
What that changes:

- **The floor question (81 → 77)** now has 12 paper entries behind it at +0.17R mean. That
  is under the 20-trade bar, and the question stays the operator's.
- **The ATR gate is a watch.** It has 11 entries at +0.24R mean, also under the bar.
  Loosening it adds exposure, so it is the operator's word too.
- **The short skip is doing its job.** It has 15 entries at −0.09R mean.
- **53 entries (+4.42R, +0.08R each) are still unexplained.** That is now the honest size
  of the gap, and the next thing to explain.

## 2026-09-23 (ninth) — the options sleeve's lever told a $5k story at $26k

**The gap.** `configuration:options_unsizable` is the options sleeve's only diagnostic. Its
lever was written on 2026-09-12, when the account was near $5k, and it hard-coded that day's
example and advice: *"one contract of a $2.93 option risks $205 at a 70% disaster stop … or
decide the sleeve does not suit an account this size."* The account is now about $26k. The
deployed scan (2026-09-23, 01:03 ET) counted 32 refusals and printed the same sentence.

**What the refusals were.** Every `live_options_risk_blocked` row records the premium it
refused (the net debit for a spread). Here they are against today's ceiling: $11.56/share at
$25,889 equity (2.5% risk × the 1.25 method weight, 70% disaster stop).

- **10 cost more than the ceiling:** LITE six times ($12.55–$19.25), SNDK three times
  ($26.65–$28.80) and GEV once ($13.05). No trade at this equity can carry one of those
  contracts.
- **22 fit under it.** 20 of them are from 09-09, when the account was about $5k. The other
  two are INTC on 09-14 ($1.30) and MU on 09-22 ($8.77). The budget that refused each of
  them was below its most.

So the advice to reconsider the sleeve matched a third of what the finding counted. It said
nothing about the rest, which were the sizing doing its job.

**Change.** The finding now reads each refusal's premium and splits the refusals against
today's ceiling. That ceiling is the most the sizer can reach: full risk at the largest
method weight. Under it, the budget that refused a contract sat below its most. That means a
step-down or another cut, a method weight under its maximum, or a smaller account at the
time.

- The detail says how many cost more than the ceiling and how many did not.
- The lever's example is the latest refusal, computed rather than fixed.
- The "does not suit an account this size" option appears only when most refusals cost more
  than the ceiling.
- The probation sentence is unchanged.

On the deployed rows the lever now reads: *"The latest, MU on 2026-09-22, was $8.77: one
contract risks $614 at a 70% disaster stop, against the largest affordable premium of
$11.56/share today. 10 were priced above the most any trade can carry at this equity … 22
fit that ceiling, so a budget below its most refused them …"*

It changes words, not decisions. The finding's count, kind and `research` direction are
unchanged, and nothing reads the lever text. A refusal row without a premium is counted but
not split. Every row in the current window has one.

**Tested.** The test account holds $26,446.53, so the ceiling is $11.81.

- MU ($8.775), AMD ($4.20) and LITE ($13.25) read "1 cost more than that and 2 did not".
- The example is LITE's $13.25, which risks $928, and the small-account advice is absent.
- With two of three above the ceiling, the advice returns.
- Restoring the old text fails both cases.

**Pre-committed check.** The next scan's `configuration:options_unsizable` must read "Of the
32 with a recorded premium, 10 cost more than that and 22 did not", give or take a refusal
that enters or leaves the window. Its lever must not contain "$2.93". As the 09-09 rows age
out of the ten-session window, the split turns toward refusals above the ceiling, and the
small-account advice returns. That is correct at this equity for LITE, SNDK and GEV.

## 2026-09-23 (tenth) — a skipped exit correction says why, and a leg outside the bracket is read

**Result of #643's deploy (first pass 01:10 ET).** The pre-committed check held on its main
line. The pass corrected COIN #656 to $204.37 `stop` (+$105.47 → −$3.22), exactly as
predicted, and four more with it:

| position | day | source | booked → fill | P&L moved |
| --- | --- | --- | --- | ---: |
| COIN #651 | 09-18 | `bracket_leg` | 189.68 → 189.06, `target` | −$69.44 |
| COIN #656 | 09-21 | `bracket_leg` | 205.0451 → 204.37, `manual` → `stop` | −$108.69 |
| MRVL #678 | 09-22 | `broker_history` | 261.00 → 261.54 | +$51.30 |
| SNOW #677 | 09-22 | `broker_history` | 337.695 → 338.76 | +$64.96 |
| SNDK #682 | 09-22 | `broker_history` | 1,888.00 → 1,881.42 | −$32.90 |

The days were re-recorded. 09-18 moved by −$69.44 to +$386.82, 09-21 from +$9.64 to
−$99.05, and 09-22 from −$128.96 to −$45.59.

The other half of the check failed. **HOOD #650** (09-18), **LITE #661** (09-21) and **MRNA
#680** (09-22) stayed at their quotes, and nothing in the journal said why. The check asked
for "a stated skip", and the pass had no way to state one.

**LITE, from the journal.** Its bracket's legs never rested. At 10:07 the protection check
found none, and its automatic re-arm failed (the inverted-side bug fixed that night). A
bracket then appeared whose order group was not the entry's (`bracket_groups_observed`,
`attributedByEntryOrderId: false`): one placed by hand. The loop ratcheted that bracket's
stop to breakeven at 10:27, the stop filled, and at 10:40 the sync booked the $969.88
quote. The entry's own order group shows no filled leg, so the pass went to the hand-sale
match. That match read only plain (`NORMAL`) orders and could not see a stop leg in another
order group. It gave up without a word.

**HOOD and MRNA** show their entry's own order group on the journal
(`attributedByEntryOrderId: true`). Their cause cannot be read from here: the app's broker
probe reads one page of the order history, and neither is on it. HOOD's quote ($117.5999)
sits four cents above its target limit ($117.56), so its leg may have filled at the
estimate. The next pass will say which.

**Change.**

- The match reads any closing fill that is not an opening order (`MASTER`), filled after
  the entry and no later than the day the sync booked the close. That covers a hand sale,
  and also a stop or target placed outside the entry's bracket, by a re-arm or by hand. A
  fill after that day belongs to a later position.
- The reason comes from the fills. All stop legs book `stop` and all take-profit legs book
  `target`. Anything else books `manual`, including a hand sale where the quote had crossed a
  level and the sync had labelled it `stop`.
- `live_exit_corrected` gains `source: outside_bracket` for a close by a stop or target
  outside the entry's bracket. Each one is a bracket that did not hold.
- An estimate the fill matches to the cent is **confirmed**. Its note is replaced, its price
  kept, and it leaves the candidates for good.
- Every estimate left alone for good journals **`live_exit_correction_skipped`** once. The
  row carries its `cause` (`aged_out`, `quantity_mismatch`, `ambiguous_legs`,
  `no_fill_price`, `no_matching_sale`, `entry_order_missing`) and the broker's evidence: the
  entry's legs and, for an unmatched close, the sells it read.
- A leg still working the day after the close is stated once a day (`combo_working`). The
  shares are gone and the order may still be live at the broker.
- Both are leak-scan execution findings, split by source and by cause.

**Tested.**

- LITE's shape, end to end. A cancelled entry bracket plus a stop leg in another order
  group books the fill as `stop` with `source: outside_bracket`. The live snapshot's
  `consecutiveLosses` goes from 0 to 1, and the scan's finding reads the row the pass wrote.
- A hand sale books `manual` over the sync's `stop`.
- A matching estimate is confirmed and never re-read, a restart included.
- Each skip cause is stated once, a restart included. A working leg is stated once a day,
  and never on the close's own day.
- Five negative checks each fail their cases: the NORMAL-only filter, no exit-day bound,
  silent skips, no confirmation, and the sync's reason kept.

**Pre-committed check.** A deploy restarts the process, so the first pass re-reads every
estimate still in the record. On that pass:

- **LITE #661** must be corrected with `source: outside_bracket` and reason `stop`, or carry
  a `live_exit_correction_skipped` row whose evidence shows why not.
- **HOOD #650** and **MRNA #680** must each be corrected, confirmed, or carry a skip row
  with its cause.
- No estimate in the seven-day window may remain without one of the three.

## 2026-09-23 (eleventh) — overlapping history pages showed one filled leg twice

**Result of #645's deploy (first pass 01:42 ET).** The pre-committed check held for LITE and
turned up a new defect for the other two.

- **LITE #661** was corrected as predicted: `source: outside_bracket`, reason `stop`, $969.88
  → $972.00 on the bracket placed by hand. Its P&L moved from −$58.17 to −$13.65.
- **HOOD #650** and **MRNA #680** were skipped with cause `ambiguous_legs`, "2 filled exit
  legs". The skip rows' own evidence showed why: each combo's three legs appear **twice**,
  identically. HOOD's take-profit filled once, 179 @ $117.56. MRNA's stop filled once, 23 @
  $179.67: its trailing stop, booked by the sync as a $181.735 `manual` win.

The skip row did its job on its first deploy: before it, these two were left at their quotes
with no statement of any kind.

**Cause.** `fetchFullOrderList` walks the order history in pages of 100 with a
`last_client_order_id` cursor. Its only guard against repeats catches a page replayed from its
first envelope. On the deployed account two consecutive pages both carried HOOD's bracket, and
two carried MRNA's. `collectLegs` gathers every envelope sharing a combo id, so every leg came
back twice and the one filled exit leg counted as two. The same repeat would double-count a
sale for both hand-close matchers (stock and options) and push their sum past the position.

**Change.**

- While walking pages, an envelope whose `client_order_id` was already taken replaces the
  earlier copy in its original position. An order is one envelope with its own id, so a repeat
  is the same order again, and the later copy was read after the first.
- A `live_exit_correction_skipped` row stops counting as a scan finding once a later
  `live_exit_corrected` row carries the same `exitId`. HOOD's and MRNA's 01:42 rows are
  history once the fix corrects them. A skip made **after** a correction still counts.

**Tested.** HOOD's bracket spread across overlapping pages reads back as three legs, with the
take-profit taken from the later copy. `decideExitCorrection` on those legs corrects the
$117.5999 quote to $117.56 `target`. Restoring the old page walk fails the case. The scan drops
a skip its exit's later correction superseded and keeps one made after it.

**Pre-committed check.** The deploy restarts the process, so the first pass re-reads both
estimates:

- **HOOD #650** must be corrected to $117.56 `target` (P&L +$418.84 → +$411.70, −$7.14).
- **MRNA #680** must be corrected to $179.67 `stop` (P&L +$49.34 → +$1.84, about −$47.49).
- 09-18 and 09-22 must be re-recorded by those amounts.
- The scan's `live_exit_correction_skipped` finding must then read zero.

## 2026-09-23 (twelfth) — the 53 unexplained entries, read one at a time

The attribution's `no_live_row` class held **53 paper entries (+4.42R)** after the (eighth)
change. Its entries became readable with #646 (`trades` on each class), and read one by one
they were not 53 unexplained decisions. Two defects in the attribution put decisions the
journal DOES explain there.

**1. The live trade went to the wrong paper entry.** The paper book re-enters a name all day
(BIAF ten times on 09-03, CRML and USDE four times each on 09-21). The live book enters once.
Pairing walked the paper list and gave each entry the nearest live trade still unused, so a
later re-entry that came first in the list took the live trade. The paper entry made in the
same tick as the live one was left over and read `no_live_row`. Seven of the 53 are exactly
that, all at 09:36 on a name the live book traded that morning: USDE 09-21, COIN 09-21, USDE
09-18, SWKS 09-15, IRD 09-09, IOT 09-04 and BIAF 09-03. The same mistake paired the live trade
with the wrong decision in the paired difference (`meanDiffR` −0.03 over 42 pairs, 95% CI
−0.27…+0.21).

**2. Four refusals the live path writes were never attribution classes.** They are written
with a symbol at the moment the live book declined, or failed to place, a candidate paper
also saw:

- `level_veto`: live-only by design, with the paper book as its control. TWST 09-17 12:32
  is one.
- `live_entry_blocked`: a guardrail refused the order at placement.
- `live_entry_failed`: the broker or its preview refused it. CRML 09-21 09:36 is one: the
  live book tried, and Webull answered "Buying power is insufficient".
- `live_order_outcome_unknown`: an unanswered placement.

The guard added for once-a-day skips on 09-12 reads only that writer, so these four went
past it.

**Change.**

- **Pairing ranks every same-symbol, same-session pair by its gap.** The live trade goes to
  the paper entry nearest it, whatever order the lists are in. The count of pairs cannot
  change, only which paper entries they are.
- **The four actions are attribution classes.** They are per-event, so they match within the
  minute of the paper entry. The level veto's class carries the paper R of the entries it
  refused, which is the evidence for or against the veto.
- **A guard accounts for every action `liveExecute.ts` writes.** Each is either an
  attribution class or named as not an entry refusal, with the reason. A new action fails the
  test until someone decides which it is. The list also fails if it names an action the file
  no longer writes.

**Tested.** COIN's shape, two paper entries and one live, pairs the 09:36 twin in both list
orders: `meanDiffR` reads 0.98, not 1.08. The 10:02 re-entry is filed under the re-entry
cooldown. At the database, a `live_entry_failed` row and a `level_veto` row classify their
paper entries, and nothing reads `no_live_row`. Restoring the old pairing fails the pairing
case, and removing `level_veto` from the classes fails the guard.

**Pre-committed check.** On the first scan after the deploy:

- The untaken total stays **134**, and paired trades stay **42**.
- `no_live_row` falls from 53. The 7 twins leave it for the paired count. The 7 re-entries
  they displace are classified by the journal where it has a row for them. The four new
  classes take what they explain.
- **USDE, COIN, SWKS, IRD, IOT and BIAF at 09:36 must not be in `no_live_row`.** If any is,
  the pairing is still wrong.
- `meanDiffR` moves, because seven pairs now compare the same decision.

What remains in `no_live_row` after this is mostly August and early September. Before
2026-09-12, several refusals wrote no row at all (the (second) through (eighth) sections).
As those sessions leave the 40-session window, the class shrinks by itself. Anything still
there from after 09-12 is a real gap.

## 2026-09-23 (thirteenth) — an options hand close that never matches says so, once

**Result of #647's deploy (first pass 02:06 ET).** The (eleventh) pre-committed check held
exactly:

- HOOD #650 was corrected to $117.56 `target`, P&L +$418.84 → +$411.70.
- MRNA #680 was corrected to $179.67 `stop`, P&L +$49.34 → +$1.84: a trailing-stop exit the
  sync had booked as a `manual` win.
- 09-18 now reads +$379.68 and 09-22 −$93.09 (09-21 −$54.53, from LITE's correction).
- The scan's `live_exit_correction_skipped` finding reads zero. All eight estimates the
  (seventh) section named are resolved: four bracket legs, three hand sales, and one stop
  placed outside the bracket.

**The options twin had the same silence.** `correctHandClosesFromHistory` re-reads, every 15
minutes, any single-leg hand close the history has not matched. Unmatched meant `continue`,
with no statement and no end: one the history can never match (you sold part of it, or
traded the contract again) was re-read for seven days and never said anything.

**Change.**

- After the close's own day, an unmatched hand close is stated once as
  **`live_options_exit_correction_skipped`**, with the contract, the quantity booked and
  every sale of that contract since the position opened. The app's own sales are flagged.
- It is not read again. The statement is checked against the journal, so a restart re-reads
  it once and states nothing twice.
- The matcher and the statement read the same sales through one filter (`contractSells`), so
  what the row says was read is what the matcher saw.
- The row is a leak-scan execution finding.

**Tested.** A two-contract hand close of which the history holds one contract's sale, moved to
yesterday:

- It is stated once, with that sale listed, and its estimate is kept.
- The scan counts it.
- The next pass reads nothing, and a restart re-reads once without a second row.
- On the close's own day an unmatched read states nothing.

## 2026-09-23 (fourteenth) — stock pairs only, and what the live book makes of paper's trade

**#648's reading is withdrawn.** #648's pairing held its own pre-committed check. The
median gap between paired entries fell from 34.3 to 5.0 minutes. But decomposing the
paired difference showed the attribution was pairing and classifying **option trades with
stock trades**. Both books carry their option trades for the scan's cuts by asset, and
`buildAttribution` matched on symbol and date alone:

- 2 of its 42 pairs set an option in one book against a stock trade in the other (SMCI
  09-04, COIN 09-18), and 4 more paired options with options.
- The 32 paper option entries left unpaired were filed under **stock** refusals, because
  the skip list holds nothing else. 7 of the 10 entries under `live_score_floor_skipped`
  were options (−1.03R of them). So were 8 of the 11 under `risk_atr_unreachable_skipped`,
  and the only entry under `live_risk_blocked:max_aggregate_open_risk`.

The attribution is now stock-only by construction. Option trades are counted
(`optionsExcluded`), not paired or classified. The live options sleeve refuses through
its own gates (one at a time, the entry cutoff, the premium ceiling), none of them on the
list, so there is no honest class to file an option under.

**The corrected reading.** Computed from the deployed rows before this change ships. The
same computation reproduces the deployed scan exactly: 42 pairs, −0.1709R, median 5.0 min.

| | as deployed (mixed) | stock only |
| --- | ---: | ---: |
| pairs | 42 | 36 |
| median gap | 5.0 min | 7.4 min |
| `meanDiffR` | −0.17R | −0.18R |
| same-tick pairs | — | 14, **−0.185R** a trade |

**Where the gap comes from.** The 14 same-tick pairs were entered within a minute of each
other. They differ at entry by 0.00R on average. So the whole −0.185R (bootstrap 95% about
−0.45…+0.02) comes after the fill:

- **Paper's stop is kinder than a real one.** Paper checks its stop on a once-a-minute
  quote and books a stop at the stop price. The live stop rests at the broker and fills on
  the first trade through it. IRD 09-09 is the clearest case. Paper entered at 09:36:31 at
  6.31 and live placed at 09:36:34. The live stop at 6.15 had filled at 6.13 by 09:39:45.
  None of paper's quotes read at or under 6.15, its 09:39:42 quote read 6.39, and it went
  on to +0.40R. That one pair is −1.58R. Without it, the other 13 average −0.08R.
- **Paper still scales out and live does not.** Paper banks 67% at +0.25R off the shared
  `partialExitRMultiple`/`partialExitPct`. Live has had `liveScaleOutEnabled` false since
  the 09-12 plan. On a trade that touches +0.25R and comes back, paper books about +0.17R
  and live books 0 at its breakeven stop. On a trade that reaches its target, the order
  reverses. Across all 36 stock pairs the scale-out cost paper 0.05R a trade on net.
  `execute.ts` says paper may differ from live in exactly three deliberate ways and
  "anything else that diverges is a bug". This one was never decided, so the next change
  makes paper follow the live flags.

**What it changes in the advice.** A refused class was priced at paper's R. The advisor
now adds the same-tick difference once it rests on 10 or more pairs, and drops a class the
live book would not have made money on. On this record no class clears it:

| class (stock only) | n | paper R | at live's fill |
| --- | ---: | ---: | ---: |
| `symbol_reentry_cooldown_skipped` | 14 | +0.11 | −0.07 |
| `entry_window_closed` | 9 | +0.10 | −0.09 |
| `no_live_row` | 30 | +0.03 | −0.15 |
| `live_score_floor_skipped` | 3 | +0.43 | under 5 entries |
| `risk_atr_unreachable_skipped` | 3 | +0.15 | under 5 entries |
| `level_veto` | 5 | −0.34 | refusing losers |

The floor question and the ATR watch both rested on option trades. The stock entries under
them are three each.

**Pre-committed check** (the first scan after this deploys, inside the same window, before
the 09-23 close):

1. `attribution.optionsExcluded` reads `{ live: 14, paper: 37 }`.
2. `pairedTrades` 36, `meanDiffR` about −0.179, `medianPairGapMinutes` about 7.4.
3. `sameTick.n` 14, `sameTick.meanDiffR` −0.1852.
4. 103 untaken entries and none of them an option: the floor class 3, the ATR class 3,
   `level_veto` 5, `live_risk_blocked:buying_power_sizing` 15, `no_live_row` 30, and no
   `max_aggregate_open_risk` class. COIN 09-18 14:17 (+0.17R) moves from paired to
   untaken. Its 11:18 entry is now the one paired with the live stock trade.
5. `GET /api/journal/tune-advice` carries no `flow:` recommendation.

## 2026-09-23 (fifteenth) — paper runs the live book's exit shape

**Result of #651's deploy (read 03:20 ET).** The (fourteenth) check held on every point:

- `optionsExcluded` is `{ live: 14, paper: 37 }`.
- 36 pairs at −0.18R (95% CI −0.43…+0.06), median gap 7.43 min.
- `sameTick` is 14 pairs at −0.19R (CI −0.44…+0.02). The app rounds the mean to two
  places, so the −0.1852 in the check reads −0.19.
- 103 untaken entries, none an option: the floor 3, the ATR gate 3, `level_veto` 5,
  `buying_power_sizing` 15 and `no_live_row` 30. There is no `max_aggregate_open_risk`
  class. COIN 09-18 14:17 moved to the re-entry cooldown, which reads 15 entries at
  +0.12R.
- The tune advice carries no `flow:` recommendation.

**What diverged.** Paper's `applyPositionManagement` read `partialExitRMultiple`,
`partialExitPct` and the three stop fields directly. The live book reads them behind two
flags: `liveScaleOutEnabled` (`scaleOut.ts`) and `liveTrailingEnabled`
(`stopAdjust.ts`). The 09-12 plan switched the live scale-out off, but paper kept banking
67% at +0.25R for eleven days. 85 of the 173 closed paper trades carry a partial.
`execute.ts` says paper may differ from live in exactly three deliberate ways and
"anything else that diverges is a bug". This divergence was never decided.

**Why it matters.** Paper is the control every live-versus-paper comparison rests on. On
the 36 stock pairs of the (fourteenth) reading, the scale-out cost paper 0.05R a trade on
net. It banks about +0.17R on a trade that touches +0.25R and comes back, and caps the ones
that reach target. The same-tick reading the tune advisor now prices refused entries with
carried that difference too.

**The change.** `liveExitRules` moves to `exitReplay.ts` and becomes the one statement of
the live exit shape:

- the scale-out, only while `liveScaleOutEnabled`;
- breakeven and the trail, only while `liveTrailingEnabled`. The declined-entry shadow
  and the exit-replay route lacked this gate too; the route also built its own copy of
  the rules.

Paper's position management, the exit-replay route's defaults and the declined-entry
shadow all read it. Live sizing is untouched: the expectancy and method multipliers read
the live book's own closed trades.

**Series boundary.** From this deploy, paper stops scaling out, because live scale-out is
off. Breakeven at 0.25R and the 0.5R/0.5R trail continue, because live trailing is on.
Paper R from before this date includes the scale-out; compare across the date with that
in mind. The scale-in (`addOnTriggerRMultiple`, `maxAddOns`) is off in both books and was
left alone. It reads its own fields, so it would diverge the same way if only the live
side were switched on.

**Pre-committed check** (first session after the deploy):

1. No `paper_partial_exit` row. `paper_stop_ratcheted` rows continue.
2. The first paper trade that touches +0.25R and comes back books about 0R, not about
   +0.17R.
3. `GET /api/journal/exit-replay` reports `scaleOutR` 0, `breakevenTriggerR` 0.25,
   `trailStartR` 0.5 and `trailStopR` 0.5.

## 2026-09-23 (sixteenth) — the scan cuts by stop width

**What the pairs showed.** The full-loss live stops in the (fourteenth) pairs filled well
through their stop price on the cheapest names: IRD 0.18R, USDE 0.13R and 0.17R, TNON
0.16R. On names over $100 the same slippage was worth almost nothing. The cause is the
width, not the name: a stop is about 2.5% of the price in every band, so on a $9 stock it
is 25 cents wide and four cents of slippage is 16% of R.

| stop width per share | live n | live R | paper n | paper R |
| --- | ---: | ---: | ---: | ---: |
| under $0.30 | 9 | −0.32 | 37 | +0.03 |
| $0.30–0.60 | 6 | −0.05 | 10 | +0.08 |
| $0.60–2 | 26 | −0.03 | 28 | +0.02 |
| $2 and over | 61 | +0.09 | 64 | +0.12 |

Nine trades is below the watch bar (10), so nothing here is actionable. The scan had no
cut that could ever say otherwise. `LeakTrade.stopWidthUsd` now carries the width, read
from the stop each book's R is measured against: `initialRiskOf` for live, the stop
paper opened with. It is null for options. The `stopWidth` dimension buckets it
(`<$0.30`, `$0.30-0.60`, `$0.60-2`, `$2+`). A narrow band that loses live and not on
paper is a watch whose lever is code: a live-only floor on the stop width in cents.

**Check.** The first scan after the deploy lists `stopWidth` among its dimensions, with
the live `<$0.30` bucket at 9 trades, verdict `ok`.

## 2026-09-23 (seventeenth) — the protection alarm's own two blind spots

An adversarial review of PR #637, the first two sections of this date (the protective
re-arm, the kill switch, the take-profit cancel, the working-close rule, the ratchet and
Order Detail), passed the side fix and the kill-switch coverage, and found two ways the
naked-position alarm could go quiet on a position that was naked. Both are in how the
alarm reports, not in what it places. Both are fixed here.

**1. A halt used up the day's page.** The `live_position_unprotected` row is the page
(`liveFailureAlert.ts`'s ambiguity actions), and the sweep wrote it once per position per
ET day whatever it said. Since the first section a kill switch writes one that reads "if
you are managing this position by hand, this is expected". Release the switch, have the
re-arm refused (or the breach close fail, when the price is through the stop), and nothing
more was written or sent: the position sat naked until the next ET day. The row now names its **state**
(`kill_switch`, `exit_working`, `unconfirmed`, `naked`,
`services/autotrading/unprotectedReport.ts`) and the sweep writes once per position per
state per day. A row from before this deploy is read by the flags it does carry
(`heldByKillSwitch`, `exitWorking`, `heldAtBroker`), so today's earlier rows suppress only
their own state.

**2. A failed holdings read looked like a closed position.** `webullAccountState` answers
`ok` with a quantity of 0 when the balance call succeeds and the positions call fails,
flagging `positionsUnavailable`. The sweep read 0 as "closed, awaiting the reconcile" and
paged nobody, for as long as the positions call kept failing. It now reads that answer as
unknown: nothing is placed, cancelled or closed, and the page goes out as `unconfirmed`.

The leak scan splits the action by the same states, from the same list (`satisfies
Record<UnprotectedReportState, string>`), so the operator's hand trading under the kill
switch no longer counts as a stop that failed. Rows before this deploy name no state and
keep the plain label.

**Found and NOT changed here, because each changes what orders the app sends or cancels
(the operator's word, as for the first section):**

- The take-profit cancel classifies a plain LIMIT on the exit side as the bracket's
  take-profit (`classifyExitLeg` falls back to the order type), so with no stop resting it
  cancels an exit the operator placed by hand once the switch is released, then re-arms
  the app's bracket. Proposed: cancel only a leg whose `combo_type` is `STOP_PROFIT`, and
  page on anything else.
- `webullPlaceStandaloneBracket` does not set `nonIdempotent`, so a timed-out re-arm is
  re-sent with the same body, and the retry's answer replaces the ambiguity the caller
  relies on. Proposed: set it, as `webullPlaceOrder` does.
- After a take-profit cancel, the next sweep sizes the pair from the holdings it reads,
  without asking whether the cancelled leg filled first.
- Latent while their settings are off: after a live scale-out partial fills, the position
  reads as "close working" for the rest of its life (the sweep, the ratchet and the timed
  exits all skip it); and a short, which the broker reports as a negative holding, is never
  re-armed.

**Check.** On the first session after the deploy, every new `live_position_unprotected`
row carries `state`, and the scan's execution findings show the state split. A kill-switch
halt that ends with a failed re-arm shows two rows for the position that day,
`kill_switch` then `naked`.

## 2026-09-23 (eighteenth) — each broker fill is booked to one exit

A second adversarial review, this time of the booking path (#638–#649), found one confirmed
wrong-booking bug that today's settings can reach, and a weaker twin on the options side. Both
are fixed here. Neither has fired yet: none of the 14 corrections and skips journaled in the
last nine days used a fill twice, and every corrected position had a single exit.

**1. One fill could be booked to more than one estimated exit (stock).** `matchSaleOutsideBracket`
matched each estimate on its own against the same fill list, oldest first, bounded above only by
the ET date the sync booked it. Nothing recorded which fills an earlier exit had used. A position
sold by hand in two pieces is the reachable case: 50 at 200 at 10:00 and 50 at 210 at 11:00, each
drop booked by the sync as it sees it. Both exits were corrected to 200, −$500 of P&L that never
happened, and the step-down, the halt, the give-back guard, the re-recorded daily rows and the
expectancy sizing all read it. The same held for two estimated positions on one symbol sold in
equal pieces, and for the bracket-leg path: two same-size estimates under one entry were both
corrected to the one filled leg, so a stop-out could read as a target win.

Now:
- each estimate's window is **time**, not a date (`SaleWindow`): a fill must land after the
  position's previous exit was booked (the sync saw shares still held then) and before this
  exit was booked, with `FILL_CLOCK_SLACK_MS` (60 s) for the broker's clock;
- estimates are matched oldest first, and a fill booked to one exit is off the table for every
  other one, both in the pass and across passes (read back from `live_exit_corrected`'s
  `fillClientOrderIds`, so a restart cannot forget it);
- a filled bracket leg closes at most one exit. Two same-size estimates under one entry are both
  left alone, and so is an estimate whose position already books an exit at the leg's own fill
  and size. Either way the skip row reads `cause: ambiguous_legs` with the reason.

**2. An options hand close could be rewritten after a restart.** The set of confirmed hand closes
is process memory, and the match had no upper time bound. After a deploy the pass re-read every
hand close from the last seven days. If the fresh history read missed the original sale (the
list read reports `ok` at its 20-page cap), a later same-size sale of the contract rewrote the
corrected row's price and `exit_at`, moving its P&L to another day. Otherwise it journaled a
false "stays an estimate" finding. Now a sale must fill at or before the recorded close (plus the
same slack), and a position already priced from a fill (`live_options_exit_corrected`, or the
sync's close with `pricedBy: broker_fill`, whose row now carries `positionId`) is not re-read.

**Not changed:** a scale-in's or per-lot add-on's entry order is found in place of the original
(`getLiveEntryOrderForPosition` takes the newest `role='entry'` row), latent while both are off;
the day stamps (give-back arm, goal reached, halt marker) are set from P&L a correction can later
move, which errs toward fewer entries rather than more; and a correction that lands on a non-final
exit re-records that exit's day rather than the day `strategyDayFor` files the position under.

**Check.** Any `live_exit_corrected` rows after the deploy name disjoint `fillClientOrderIds`, and
no hand close already priced from a fill is re-read after a restart (no second
`live_options_exit_corrected` row for the same position).

## 2026-09-23 (nineteenth) — the take-profit cancel touches only its own leg, and a re-arm is sent once

Two of the (seventeenth) section's findings change which orders the app cancels or sends, so
they shipped on the operator's word, as #637 did.

**1. The take-profit cancel could cancel the operator's own exit.** `classifyExitLeg` reads
`combo_type` first and falls back to the order type, so a plain LIMIT on the exit side reads as
a take-profit whoever placed it. The cancel branch cancelled every leg once they all read that
way, and only the app's own closes were exempt (a working close takes the branch before it).
The User Guide's own hand-trading workflow reaches it: engage the switch, cancel the bracket,
rest a sell limit in Webull, release the switch before it fills. The next sweep cancelled that
limit within a minute, the sweep after re-armed the app's bracket at the ledger's stop and
target, and the row it wrote (`live_bracket_rearm_target_cancelled`) pages nobody.

Every leg of every bracket this app places carries `combo_type` `STOP_PROFIT` or `STOP_LOSS`
(`bracketExit`), and its plain orders carry `NORMAL`. The branch now cancels only when every
resting leg is labelled `STOP_PROFIT`. An exit-side limit labelled anything else, or nothing,
is someone else's order: nothing is cancelled, and the position pages with the labels it saw.
The cost is bounded: if a parse regression ever strips the label from the app's own orphaned
take-profit, the sweep pages instead of repairing, which is what it did before 2026-09-12.

**2. A timed-out re-arm was re-sent.** `webullPlaceStandaloneBracket` did not set
`nonIdempotent`, so a timeout, a network error or a 429 re-sent the same body up to the
client's retry limit, and the caller saw the retry's answer. If the first POST had landed, that
answer is most likely a refusal of the duplicate ids, which reads as an explicit rejection
rather than an unanswered placement. The protection sweep treats an explicit refusal as fact
(2) of the breach close, and the scale-out's rollback treats one as licence to restore the
full-size bracket, both on top of a bracket that may be resting. It is now sent once, as
`webullPlaceOrder` and `webullReplaceOrders` are.

**Not changed, with the reason:**

- After a take-profit cancel, the next sweep sizes the pair from a fresh holdings read, and
  does not ask whether the cancelled leg filled first. A stale read would size legs over
  shares no longer held. The legs are `SELL`, not `SHORT`, so the broker refuses them rather
  than opening a short; the cost is a false "re-arm failed" page.
- An unknown-outcome placement is retired after five minutes absent from both lists without
  an Order Detail read. No `live_order_outcome_unknown` row has been written in the last ten
  sessions, so the case this guards has not occurred on this account.
- The scale-out's "close working" lock-in and the unhandled short holding stay latent while
  `liveScaleOutEnabled` and shorts are off.

**Check.** No `live_bracket_rearm_target_cancelled` row names a leg whose `combo_type` was not
`STOP_PROFIT`. A position with a hand-placed sell limit and no stop pages with "not labelled as
a bracket's take-profit".

## 2026-09-23 (twentieth) — a stock order is shares, not an option on the same name

**What happened.** At 09:37 both sleeves bought MRNA: the stock sleeve 129 shares (entry
186.22, stop 181.16, target 190.45), the options sleeve 3 calls (195 strike, 2026-09-25, at
2.84). The generic broker sync imports every holding into `positions` as an untagged
`['webull']` row under the symbol, so the two holdings became row 690 (the shares) and row 692
(the call). When the stock order's fill reconciled at 09:38:39, `materializeEntryFill` looked
for an untagged row on MRNA to link rather than create a duplicate, newest first, and took 692.
The call was tagged `autotrade` with the shares' stop and target. When the options sleeve sold
the call, the sync closed row 692 at an estimated 1.56, and the stock book booked −$384 it
never lost (the options book booked the same call correctly, −$207). The shares' take-profit
filled at 190.45 (about +$546) against row 690, which nothing had tagged, so the stock book
never counted it. At 10:23 the daily halt read the booked day at −$2,046.47 against a line of
−$1,941.67 and tripped; the real figure was about −$1,117 (−4.3%). No entry was placed for the
rest of the session.

**The rule.** A stock order fills in shares, so only a `stock` row can be its fill:
`materializeEntryFill` and `adoptOrphanedLivePositions` both now require `assetType ===
'stock'`. The comment that justified the symbol-only match ("an orphan for this symbol
appearing before the fill reconciles can only be this fill") was true while one sleeve traded
the names. It stopped being true once the options sleeve traded them too. The adoption pass also consumes an
order once it matches, so one order adopts one holding. It used to adopt every untagged row
on the symbol, each link overwriting the last.

**The same confusion, one layer down.** Two other reads keyed on the symbol alone.

1. **The broker holding.** `webullAccountState(account, symbol)` without an instrument returns
   the per-underlying sum: shares plus every option contract on the name. The manual order
   paths pass their instrument, and the options sleeve feeds its guardrails its own ledger
   quantity. The stock sleeve asked for the sum at all six of its reads (entry, protection
   sweep, time exit, scale-out, scale-in, per-lot second lots), and the protect-a-long route
   asked the same way. The protection sweep reads "holds 0" as closed, so a stop that filled
   while the options sleeve still held calls on the name read as naked shares: the sweep paged
   and sent a re-arm, or a close through the stop, for shares no longer held. Those orders go out as
   SELL, not SHORT, so the broker should refuse them. But the app's own `naked_short` check,
   which exists so that no sell depends on that, was reading the padded count. All six reads
   now go through `stockAccountState` (the stock instrument), the route asks for the stock,
   and a source scan fails if a two-argument read comes back into `liveExecute.ts`.
2. **The open-orders list.** An options order carries the underlying as its symbol. So the
   options sleeve's working close on a call is, by symbol and side, a resting SELL LIMIT on
   the shares, and `classifyExitLeg` reads a LIMIT as a take-profit. A time exit's bracket clear
   cancelled every resting sell on the symbol, the options sleeve's close included. The
   protection sweep read that close as a take-profit resting without its stop, and held back
   from re-arming (until the (nineteenth) change this morning it cancelled it). The
   protect-a-long route counted its contracts as shares already committed. The open-orders
   parse now keeps `instrument_type` (from the order, else its envelope). `restingExitOrders`,
   `unreadableOpenOrders` and `committedProtectiveQuantity` skip an order positively labelled
   `OPTION`. An order whose type cannot be read is still treated as a possible stock leg, so
   a response without the field behaves exactly as before.

**Measurement.** The held-symbol skip (`live_symbol_held_skipped`) named the options sleeve's
contracts `manual`. All four of 09-23's `manual` rows (AMZN, DELL, HOOD and TSLA) were the
sleeve's own contracts. They are now `options_sleeve`. The refusal is unchanged. The stock sleeve
still does not enter a name the options sleeve holds. The options sleeve still enters a name
the stock sleeve holds (CRWD at 10:13, beside the 09:51 shares). Both can enter one name in
the same minute (MRNA). Whether the two sleeves may stack on one name is a sizing decision,
not a defect, and it is left as it is.

**Not changed.** The options sleeve's own reads: its exits hand the guardrails its ledger
quantity, and its entries are buys, which neither `naked_short` nor the per-symbol quantity
cap (disabled for both sleeves) reads.

**Today's ledger** is corrected by hand after the close: row 692 is untagged, row 690 is booked
as the loop's trade at its 190.45 fill, and the day is re-recorded.

**Check.** No `live_position_adopted` or `live_position_linked_to_adopted` row names a position
whose `assetType` is not `stock`. `GET /api/autotrade/live/open-orders` shows `instrumentType`
on each order (`EQUITY` on the bracket legs). On the next day both sleeves hold one name, no
options close appears among the orders a stock time exit cancels.

## 2026-09-23 (twenty-first) — a halt that tripped on a booking error can be withdrawn

The live halt fired at 10:23 on −$2,046.47 against a line of −$1,941.67. −$384 of that was
the options sleeve's MRNA call, linked to the stock order's fill and booked into the stock
book at an estimated price (the (twentieth) section and its fix). With the ledger corrected,
the loop's closes that day never put its running total at or under the line: about −$1,662
when the halt fired, and about −$1,821 at its lowest, at 10:51, before the day's two
estimates are repriced.

The halt itself is recomputed on every risk check, so correcting the ledger changes what the
next check sees. But the day's record kept it. `recordDailyResult` ORs the stored flag so that
"a re-record can never clear a halt already written", and the sizing review's "revert if the
halt trips twice in any five sessions" counts that flag. A phantom halt would therefore cut
the size on the next real halt, for a loss the loop never took.

**The rule.** A halt stops counting only through an explicit, journaled retraction:
`POST /api/journal/daily-halt/retract` with `{ date, reason }` (`dailyHaltRetraction.ts`).

- **The day it reads.** `liveDayCloses` lists the loop's closes on the date: autotrade stock
  positions closed with their last exit on the date, and live options positions whose exit
  falls on it. `strategyDayFor`, the day's record, sums the same list, so the retraction and
  the calendar cannot read different days. The options side is read by date. The first
  version read it through `listLiveOptionsPositions`, whose newest-200 default drops any date
  older than the book's latest 200 closes.
- **What it asks.** `dayReachedLine` walks those closes in booking order (a stock position at
  its closing exit's booking time, an options position at its exit time) and takes the lowest
  running total. The retraction is refused (409, with that reading) if the lowest point is at
  or under the marker's line; the checks halt at `pnl <= level`. A close with no booking time
  inside the session (an exit entered or re-entered by hand after the close) is placed where
  it hurts the retraction most: a loss before every other close, a gain after them all. It is
  also refused while that session is still open, since the alert marks once a day and a halt
  withdrawn mid-session could trip again without being counted.
- **It keeps being checked.** `liveDrawdownHaltRetracted` honours a retraction on file only
  while the corrected ledger still bears it out, re-read on every call. The recorder, the halt
  reader and the nightly scan all ask that one function. So if a later correction (an estimate
  repriced to its fill, a loss entered late) puts the day at or under the line, the halt
  counts again on the next re-record, the scan shows it again, and the retraction stops being
  reported.

The marker stays as history. The retraction is its own row, `daily_halt_retracted {pool,
date, reason, markerPnl, haltLevel, lowestPnl, totalPnl, stockPnl, optionsPnl, untimedCloses,
markerAt}`. The route re-records the day, so the results row and the review drop it at once.

**Why not judge the moment the halt fired.** That was the first version, and a review found
three ways it withdrew a halt the loop's own trades earned. Each has a test that fails on it:

1. A later crossing. The alert marks once a day, so a day that crossed the line again at
   11:30 on its own losses had no second marker, and the 10:23 reading cleared it.
2. A loss re-entered after the close. Deleting and re-posting an exit books it at the time of
   the edit, which read as "after the halt", so the loss dropped out of the check.
3. An options loss older than the book's newest 200 closes, dropped by the list's default
   cap.

It also judged once and stored the verdict, so an estimate repriced afterwards could not
bring a real halt back.

**Check.** After the ledger correction, the retraction for 2026-09-23 succeeds with a lowest
point above −$1,941.67, the 09-23 results row reads `drawdownHalted: false`, and the sizing
review's `haltsMaxIn5` does not count it. A retraction attempt against a day whose running
total reached the line answers 409 with the reading.

## 2026-09-23 (twenty-second) — an order the lists have not shown yet has not aged out

The exit-correction pass reprices an exit the position sync booked at a quote, from the
entry's bracket in the broker's order lists. When neither list showed the entry it concluded
the combo had "aged out of history", marked the exit final, and never asked again. Webull's
history keeps seven days of orders, and it lags a fill by minutes. GRML's stop filled in the
09:52 minute, and the pass asked seconds later. DELL's stop filled at 10:47, and it asked
at 10:51. Both combos had been placed that morning, both came back "not found", and both
estimates (16.04 and 551.878) were frozen as final. A combo a quarter of an hour old (SMCI,
10:22) was found the same morning.

**The rule.** An entry placed less than `STOCK_EXIT_CORRECTION_LOOKBACK_DAYS` (7) ago that
neither list shows is `not_listed_yet`. That skip is journaled once a day, is not final, and is
asked about again on the pass's 15-minute cadence. Only an older entry is `aged_out`. So an
entry the lists never show keeps the pass asking for seven days, not forever, and a pass
that already runs every 15 minutes reads the two lists once for all its rows. The nightly
scan does not count `not_listed_yet` at all: it is a wait, and what the next pass decides (a
correction, another cause, `aged_out`) is the finding. Counting it left a finding open for
ten sessions after a pass that confirmed the estimate to the cent, which writes no
correction row, and doubled an exit that ended in another cause.

**Check.** No `aged_out` skip names an entry placed within the last seven days. The next
same-day stop the sync prices at a quote is corrected to its leg's fill within about 15 minutes.

## 2026-09-23 (twenty-third) — a miss count ends with the position it counted

The broker sync books a close only after Webull has left a position out of two consecutive
syncs. For a position with a resting bracket it also waits four syncs and four minutes from the
first miss, so the entry order's own reconcile can book the leg's fill. The count lives in
`webull_miss_streak`, one row per account and contract. Until now two things ended it: a sync
that found the contract held, or the sync closing the lots itself.

An exit the loop books itself does neither. A leg fills, or a time exit fills, the sync starts
counting, and the order's own reconcile books the fill. The contract then has no open lot, so no
sync looks at it again, and its row keeps its count and its start time. On 2026-09-22 and 09-23
that happened four times: GRML's take-profit, the NVAX and MU time exits, and SHOP's stop. The
other deferred exits were booked by the sync after its grace, which does clear the count. The
four-minute floor (#641, 2026-09-23) gives the reconcile longer to get there first, so this
will happen more often.

The next position on that contract inherited it. GRML's take-profit filled on 2026-09-22 at
10:29. The sync counted it missing and deferred, and the reconcile booked the 13.72 fill at
10:31:01. On 2026-09-23 a new GRML position (786 @ 16.71) had its stop fill within about a
minute. The first sync after the fill ran one second after the position was booked. It read the
old count and the 09-22 start time, so the two-sync debounce and the four-minute grace both read
as spent. It booked the 16.04 quote as the stop before the entry's reconcile could book the leg.
The exit correction gave up four seconds later because the order lists had not shown the entry
yet (the (twenty-second) section).

A leftover count also defeats what the debounce was built for in 2026-07: one incomplete
positions read no longer closes a held position. With a count left behind, one read that lags a
fresh entry's fill is enough.

**Change.** Each sync first ends every count in its account for a contract it has no open lot
for (`clearMissStreaksWithoutLots`). The options sleeve keeps its own counts in the same table
as `opt:<position id>`, and those are left alone.

**Scope, measured.** Since 2026-09-08, one live position was booked from a quote without the
sync deferring it first: GRML, one second after the fill. The rest of the quote-priced closes
with no deferral were hand trades, which have no bracket and close after two misses by design.
GRML's shares were really sold, so the harm is the price: 16.04 is a quote, not the stop's
fill. The correction pass keeps its "aged out" verdicts in memory only. After the next restart
it reads GRML's bracket again, and by then the lists show the stop. NVAX, MU and SHOP still have
a count left behind in production; the first sync after this deploys ends them.

**Not covered.** The count ends on the first sync after the old position closes. A new
position on the same contract booked before any sync runs in between would still start with
it. Syncs run at least once a minute, and the loop's 390-minute re-entry cooldown keeps it
off the same name for the rest of the day, so only a hand trade could reach that window.

**Check.** A bracketed position's first `position_reconcile_skipped` row carries a
`missingSince` within a minute of its stop or target filling, never from an earlier day. No
`position_reconciled_from_broker` row for a bracketed position lands within four minutes of its
first miss.

## 2026-09-23 (twenty-fourth) — the drawdown halt holds for the rest of the day

Every risk check compared the day's realized P&L with the halt level on its own, tick by tick.
So the halt lifted as soon as a position still open when it tripped closed green. The live halt
tripped at 10:23 on −$2,046.47 against −$1,941.67. CRWD's take-profit filled at 11:47 for
+$382.20, the day read about −$1,822, and the loop bought 415 VKTX at 11:49 (stopped at 12:02,
−$16.60). The operator had asked for the day to stay stopped, and the kill switch was engaged
by hand. The halt's own notification says new entries are blocked "for the rest of today", and
the User Guide's risk settings say the drawdown "halts new entries until tomorrow". The code
did neither.

**The rule.** `dailyHaltVerdict` in `riskCheck.ts` is now the one halt rule for every book;
the stock and options risk checks both call it. It fails while the day is at or below the
level, as before, and also whenever `ctx.dailyHaltTripped` is set. That input is required, so
every caller has to set it:

- the live stock and live options sleeves pass `liveDrawdownHaltedOn(today)`, the live pool's
  marker (stock plus options, as both live checks measure), less a retraction that holds;
- the paper books and the two risk-check previews pass `haltMarkerExists('paper', today)`;
- the backtests pass `false`. A replayed day books all its closes before the day's checks run,
  so its one check already sees the day's net, and there is no intraday order of closes to
  reproduce the live stickiness from.

The marker is written by the first tick that finds the pool at or below its level
(`dailyHaltAlert.ts`). So a day that dips through the line and recovers between two ticks
never trips, as before. The detail line reads "halted for the rest of today, tripped earlier"
so the refusal says why when the day's figure is above the level.

A halt that tripped on a booking error holds too. The retraction (the twenty-first section)
is refused while the session is open, so it corrects the day's record after the close and
never re-opens entries the same day.

**The Monitoring card.** The dashboard gains `dailyHalt: { paper, live }`, each read through
`dailyHaltVerdict` with the same inputs the checks use: paper on the paper pool (equity plus
options) and its marker, live on live stock plus live options and `liveDrawdownHaltedOn`.
An unset equity makes the level 0, which never reads as a halt. The card's "HALT TRIGGERED"
label reads that field. It used to compare each column's own day P&L with the level, so the
two live columns judged each sleeve against a halt measured on their sum: at 10:23 stock
read −$1,540.47 and options −$506 against −$1,941.67, and neither column showed the halt
every live check was applying.

**The live add-on gate.** A third copy of the rule lived in the live scale-in
(`placeLiveScaleInAddOn`, off in production: `liveScaleInEnabled` false). It compared the stock
sleeve's P&L alone with the level, each tick. It now calls `dailyHaltVerdict` on the live pool
with `liveDrawdownHaltedOn`, the same verdict as the entries. `checkLiveScaleIns` takes the
options sleeve's day as a required argument, and `loop.ts` passes it from `liveOptionsDay()`,
the one derivation the entries read too. It is required and not defaulted because a default of
zero is how a caller would judge the stock sleeve alone again.

**Not covered.** The second lot of a per-lot bracketed entry (`checkLivePerLotSecondLots`, off in
production) is not gated by the halt. It completes an entry that was sized and risk-checked in
full before the halt tripped, and its own comment says so. Whether a halted day should also stop
that second lot is the operator's call.

**Check.** On the next live halt, no `live_order_placed` or `live_options_order_placed` row
appears later that ET day, and every `live_risk_blocked` row after the marker names
`daily_drawdown_halt`.

## 2026-09-23 (twenty-fifth) — the history readers see the whole book

`listPaperPositions`, `listOptionsPaperPositions` and `listLiveOptionsPositions` capped a call
with no `limit` at the newest 200 rows, and `listAutotradeLivePositions` did the same in memory.
Every history reader called them without one: the edge-leak scan's paper control and its live
options rows, the daily-target sweep (`collectBook`), the results row's paper column
(`paperDayFor`) and the backfill, the tune advisor, the symbol cooldowns, method sizing, the
risk snapshot's options closes, and the dashboard. None of them could tell a book of 200
closed trades from a longer one. The paper book had 179 on 2026-09-23 and adds several a
session, so within a few sessions each of those readers would have started dropping its
oldest trades without a word. The retraction (the twenty-first section) had already met the
same cap and was given a date-scoped read of its own.

**The rule.** An omitted `limit` now means every row. One helper, `db/rowLimit.ts`, applies
it for all four lists (a SQL clause for the three tables, a slice for the live stock filter).
A page is the caller's choice: the four positions routes ask for
`POSITIONS_PAGE_SIZE = 200` when the request names none, which is the page the Auto page has
always shown, and still accept `?limit=` up to 1,000. The callers that already passed a
limit keep it: the three executors' "today" reads (500, newest first) and the excursions
route (1,000, with its coverage count).

**Tests.** `historyReaders.test.ts` seeds 205 closed rows in each book and checks the lists,
the consumers (the sweep's paper and live options trades, and the results row's paper P&L on
the book's oldest day) and the four routes' default page. Seven of its eleven cases fail on
the old code; the four route cases pass on both, since they pin the page the UI already had.

**Check.** Once the paper book passes 200 closed trades, `GET /api/journal/edge-leaks` reads
`coverage.paperTrades + paperOutsideWindow + paperDropped` equal to the closed rows of
`/api/autotrade/paper-positions` plus `/api/autotrade/options-paper-positions`, each read with
`?status=closed&limit=1000`.

## 2026-09-23 (twenty-sixth) — the market-direction gate

On 2026-09-23 the live book bought SHOP (09:50), GRML (09:52), SMCI (10:08) and DELL (10:13)
with SPY 0.29–0.51% under its prior close and 68–75% of a sampled universe red. All four lost,
−4.09R between them. The operator asked for the market's overall direction to be read and
acted on: "make sure it takes into account red days like today. They may not seem violent
but can be outreaching to all stocks and vice versa for green days." Nothing on the entry path
read direction:
- the ML regime overlay reads a daily model (Low-Vol Bullish that morning);
- the ATR guard and the shock nowcast read volatility;
- the marketRegime gauge (trend, breadth, volatility) is display-only;
- the screener scores each name on its own tape.

**The reading** (`services/autotrading/marketDirection.ts`, pure). It has two legs:
- the index: SPY's move against its prior close, from the quote's `changePct` or derived from
  `last` and `prevClose` (`getMarketChangePct`). It is null on the synthetic provider or a
  failed read.
- breadth: the count of scored universe names below, above and at their own prior close,
  pass or fail (`ScreenResult.breadth`). Movers-only names are left out, since premarket
  gainers are green by selection. Only a move read from the name's own quote counts: when a
  quote fails, the indicator falls back to the last two daily bars, which during the session
  can be yesterday's move, so that name is left out rather than counted.

The reading is red when SPY is down at least `marketDirectionIndexPct` AND at least
`marketDirectionBreadthPct` of the measured names are red. Green is the mirror; anything else
is mixed. It is unknown without an index move or with fewer than 100 names measured. Both
comparisons use the raw values, not the rounded ones shown. The loop reads the market once a
tick after the screen, puts it on the tick summary (the Monitoring card's Last cycle line),
and journals `market_direction_read` when it changes (`claimDirectionChange`), with the gate
on or off.

**The gate.** The loop hands the reading to both live executors, the same object to each.
With `marketDirectionGateEnabled` on:
- the stock book refuses a long on a red reading and a short on a green one, after the score
  gate. Each refusal is therefore an entry the book otherwise wanted. It is journaled as
  `live_market_direction_skipped` through `journalDeclinedEntry`, so it carries the replay
  fields.
- the options sleeve refuses a call on red and a put on green, after its finish-line gate,
  journaled as `live_options_market_direction_skipped`.

Paper is not gated; it is the control.

**Measured.**
- The attribution reads `live_market_direction_skipped` as a standing once-a-day refusal, so
  paper entries the gate refused file under their own class. The tune advisor names
  `marketDirectionBreadthPct` as that class's lever.
- The edge-leak scan gains a **Market direction at entry** dimension (with, against or mixed).
  It places each trade in both books against the `market_direction_read` row in force at its
  entry, the latest at or before it on the same ET day. Its lever on `against` is the gate
  itself, and it is not writable by the gated switches.

**Config.**

| Field | Default | Range | Classification |
| --- | --- | --- | --- |
| `marketDirectionGateEnabled` | false | boolean | never tuned |
| `marketDirectionIndexPct` | 0.2 | [0, 5], a 400 outside it | never tuned |
| `marketDirectionBreadthPct` | 65 | [50, 100], a 400 outside it | never tuned |

The three are read in `loop.ts`, `liveExecute.ts` and `liveOptionsExecute.ts`.

**The calibration.** Breadth was rebuilt for 22 sessions (2026-08-24..09-23) from Polygon minute
bars of a 60-name random sample of the universe, and each of the 242 trades on the tape was
placed against the reading at its entry minute. At 0.2% / 65%:

| Book | Trades refused | Mean R | Total R | Winners |
| --- | --- | --- | --- | --- |
| Live longs | 30 | −0.217 | −6.50 | 37% |
| Paper longs, same readings | 24 | +0.212 | +5.09 | 83% |

The live loss sits on 09-09 (−2.20R over 12) and 09-23 (−4.09R over 4). The paper gain sits on
09-09 (IRD, CHYM) and 09-18. The books disagree, so part of what the gate removes may be live
execution on a falling tape rather than direction alone. The alternatives:

| SPY / breadth | Live refused | Live R | Paper R |
| --- | --- | --- | --- |
| 0.2% / 70% | 24 | −6.23 | +4.66 |
| 0.25% / 65% | 27 | −5.06 | +4.83 |
| 0.3% / 65% | 22 | −3.15 | +4.48 |

0.2% / 65% is the only row that catches all four of 09-23's entries. At it the reading was red
on 31% of session minutes and green on 13%, and it flipped about ten times a day on the
60-name sample.

**Pre-committed check.**
1. On 2026-09-24 the first `market_direction_read` row lands within a minute of the first
   screened tick. The Last cycle line shows it, and with the gate on a red reading journals
   `live_market_direction_skipped` for every floor-passing long.
2. After 20 live refusals, read the attribution class `live_market_direction_skipped`. If
   paper's mean R there has a 95% interval above zero, raise `marketDirectionBreadthPct` to
   70. If it still reads above zero after another 20, turn the gate off. Otherwise keep it.

## 2026-09-23 (twenty-seventh) — three numbers the evening review read wrong

The post-close review on 2026-09-23 read three figures that were wrong at the source.
None of them moves an order. Each one fed a check that tells the operator whether
something needs fixing.

**1. The entry-fill check read one option fill against a stock limit.** The MRNA stock
entry order had been linked to the MRNA call's row that morning. #658 stops a stock order
adopting an option holding, and the hand correction of the ledger fixed the prices and
tags, but the order row's `position_id` still pointed at the call. `buildLiveSlippageRows`
then measured the call's $2.84 fill against the shares' $187 limit: −98.5%. One row was
enough to move every window.

| Window | `meanEntryBufferConsumedPct` read | Without the row |
| --- | --- | --- |
| 1 session | −13.9 | about +0.05 |
| 10 sessions | −1.93 | about +0.05 |
| 40 sessions | −0.85 | about +0.05 |

A negative figure means fills landed better than the quote, which a marketable limit
cannot do on average. The `execution:entry_slippage` finding fires above half the 0.5%
buffer, so it could not have fired for 40 sessions whatever the fills were.

The fix is on both ends:
- `getLiveEntryOrderForPosition` answers only for a stock row. It reads the stock sleeve's
  order table, so a link from it to an option row is a cross-link by definition. That
  covers every reader of links written before #658: bracket ownership, the Auto-page
  close, the exit correction, the fill check.
- The row builder asks whether the order could have produced the fill at all
  (`slippage.ts`'s `limitIsReference`). An entry counts only against an opening order of
  the same instrument. That also catches a cross-link carried on `source_intent_id`.

The shares' row (690) has no entry link as a result, so its entry fill is not measured.
That is one entry in about 110.

**2. The Journal's slippage report measured bracket legs against the entry.** A stop or
take-profit leg fill is booked against the bracket's own order, which is the entry
(`materializeExitFill`). The report compared the leg's fill with the ENTRY limit, so the
"slippage" was the trade's own move. DELL's run to its target on 2026-09-02 read as +4.6%
of cost. That was true of 35 of 106 exit rows. An exit now counts only against a closing
order the app priced itself (a time exit, a stagnation close, a close from the app), never
a bracket.

The route also walked positions on its own, reading `source_intent_id` only, so it missed
every adopted entry. It now serves the same `buildLiveSlippageRows` the leak scan and the
per-symbol exclusion read, so none of the three can disagree about which fills count.
The exclusion read a target fill as cost, and so leaned toward excluding the names whose
trades worked. It never fired: production has no `auto_tune_symbol_excluded` row, and none
of the nine current exclusions is slippage-based. It is dormant while `autoTuneEnabled` is
off.

**3. The leak scan judged a cut chosen by the outcome.** "Exit reason = stop" became a leak
that evening: 31 live stop exits at −0.27R (95% −0.47…−0.07), paper's 93 at −0.11R. A
stop exit loses by construction, so the bucket clears the bar on any book that uses stops
once enough have fired. The tune advisor priced it at +1.06% a day. It priced the
red-day decomposition's own "stop" driver at +0.93% more. Together those were all of the
1.99 points its headline said "everything measurable" adds. The fix:
- Exit reason and hold time, the two cuts known only at the exit, now report their buckets
  with the verdict `descriptive`. They are never a leak or a watch, and carry no lever.
  The `DimensionReport` says why (`descriptive`).
- The advisor's red-day driver stays a research item and carries no estimate.
- What a different exit would have kept is the exit replay's question.

**Pre-committed check (the first scan after the deploy).**
- `GET /journal/edge-leaks?sessions=40&book=both&persist=false`:
  - `attribution.meanEntryBufferConsumedPct` reads between 0 and 0.5, near the +0.05
    baseline of 2026-09-12. A negative figure means another cross-instrument row is still
    in the fills.
  - Neither `exitReason` nor `holdMinutes` appears in `leaks` or `watches`.
- `GET /journal/slippage`: no exit row whose `side` is the position's opening side.
- `GET /journal/tune-advice`: no `edge:exitReason:*` recommendation, and every
  `edge:red_day_driver:*` has `expectedDayPctDelta: null`.

## 2026-09-23 (twenty-eighth) — a live short is protected, closed and booked the way a long is

No live short has ever traded (`liveAllowNakedShort` is false), and the shorts rule was three
trades from proposing it. So every path a short would run for the first time was audited
before that proposal could arrive. The audit ran as three read-only reviews: placement,
management and booking. Each finding below was confirmed in the code before it was fixed.

**Found and fixed:**

| # | Finding | Fix |
| --- | --- | --- |
| 1 | The broker reads a short as a NEGATIVE quantity (`accountState.ts` signs it). The protection sweep acted only on a positive one, so a naked short was paged and never re-armed or closed through its stop. The one test gave a short +10, a shape the reader never returns. | `heldShares` reads the holding in the position's direction. A holding the other way round confirms nothing and pages as unconfirmed. The fixture is now −10. |
| 2 | Whether a sell went out as Webull's SHORT or a plain SELL came from the broker's quantity, while "already held" came from the ledger, which the sync refreshes every few minutes. A short against shares the operator had just bought would have sold them. A long against a short they held would have bought it back. | `attemptLiveEntry` refuses an entry while the broker holds the name the other way round (`opposite_holding`), and a short when the holdings read failed (`holding_unknown`). A long with an unreadable holding goes on as before. |
| 3 | Adoption matched a holding on symbol alone. | Both adoption paths require the holding's side to match the order's (`positionSideOf`, the one mapping the create path also uses). |
| 4 | A close ordered `remainingQuantity` whatever the broker held. The naked-short guardrail was the long side's only protection in the app against overselling, and switching shorts on turns it off. Nothing in the app stopped a short's cover buying past zero. The broker has refused a close that would reverse a position, but whether it refuses these has never been seen. | `placeLiveEquityTimeExitClose` refuses a close larger than the holding in the position's direction: none held, fewer than the remainder, or held the other way round (`live_time_exit_blocked`, `broker_holding: …`). It refuses before anything is cancelled, so the bracket stays. |
| 5 | The exit correction matched SELL fills only, so a short covered by hand never found its fill. The correction's journaled `pnlDelta` ignored side. | The closing side comes from the position (a BUY for a short), and `pnlDelta` is signed by side. |
| 6 | A broker refusal of a short (hard to borrow, no locate, the short-sale rule) was retried every tick. | A definite refusal holds that symbol's shorts for the ET day (`refusedShorts.ts`, `short_refused_today`). It is checked before the quote and the account reads. An unanswered refusal does not hold, nor does a buying-power one (the learned ceiling sizes the next attempt down). |
| 7 | Nothing compared the placement quote with the stop. The bracket guardrail compares the limit, 0.5% beyond the quote. | An entry whose quote is at or through its stop is refused (`through_stop`). Not seen on the record: 39 placements, the nearest 1.19% from its stop. |

Each refusal in 2, 6 and 7 writes `live_entry_guard_refused` through `journalDeclinedEntry`,
once per symbol per ET day, naming the first guard that fired. The row has the same shape as
every other declined live entry: side as long/short, the floor and `liveEligible`. The
action is in the attribution's once-a-day skip classes.

**Revised after the PR's own review** (a read-only adversarial pass over the diff):
- **The close was first CAPPED at the holding.** It is now refused instead, for three
  reasons:
  - a capped fill books as a scale-out, because `materializeTimeExitFill` tells the two
    apart by quantity alone, and that strands the rest of the position for the sync to
    estimate;
  - a holding can include a lot the operator holds in the same name, which a capped sell
    would take while the loop's own shares were already gone;
  - a fractional hand lot would have become a fractional order.

  Refusing is what `naked_short` did for a long, now on both sides.
- **The guard rows first wrote the order side (`sell`),** so the declined-entry replay
  scored every refused short as a long, and the rows carried no floor.
- **A buying-power refusal held the symbol's shorts for the day,** overriding the ceiling
  learned in the same branch.

**Not fixed here:**
- The attribution pairs a live trade with a paper one on symbol and day without checking
  side, so a live long could be compared with a paper short. It is a measurement fix of its
  own.
- The shadow replay's optimism is shared with every replay-based record. It fills at the
  signal price, books stops at the level even through a gap, arms breakeven on intrabar
  extremes, counts a target touch as a fill, and skips several live gates. Changing it
  moves those records too, so it waits for the operator.
- How Webull reports a stock short in its positions has never been captured. A one-share
  test short and `npm run capture:broker` would settle it.
- The close's check reads the holding before the bracket's legs are cancelled, so a leg
  that part-fills between the two is not in it. The broker's reversal refusal is the
  backstop, and the next tick re-reads the holding. This predates the change: `naked_short`
  read the same holding at the same point, and it needs a leg to part-fill inside a second
  or two.

**Tests (each mutation-checked):**
- the protection sweep re-arms a short with BUY legs at −10, closes a naked short the
  market has run through with a BUY, and acts on nothing when the broker holds the name
  long;
- the close refuses when the broker holds fewer shares than it would order, with shorts
  on or off, and cancels nothing; it refuses with none held, covers a short with a BUY,
  and refuses a short when the broker holds the name long;
- adoption skips an opposite-side holding, both in the orphan sweep and at the fill;
- each entry guard refuses, journals once and places nothing; a same-side holding still
  trades; an unanswered short is not remembered;
- a refused short's row replays as a short (`parseDeclinedEntry`), and carries the floor;
- a buying-power refusal does not hold a symbol's shorts;
- a short refused earlier today is refused before the account is read;
- the exit correction reads a short's BUY, and a lower cover is a positive `pnlDelta`.

## 2026-09-23 (twenty-ninth) — a finding says whose it is

The tune advice's headline that evening read "5 execution defect(s) outrank everything
measurable here … Fix what is broken before tuning what is merely small". One of the five
was `live_exit_corrected|broker_history`: three sales the operator made by hand in Webull,
re-booked at their fills. The catalog's own comment calls that "not an app defect", and
the advice still told the reader to root-cause it and fix the path. The same held for
every class the catalog labelled benign or expected, and for the risk controls doing
their job.

Each execution class now carries a nature (`ExecutionNature`), `defect` unless stated:

| Class | Nature |
| --- | --- |
| `live_exit_corrected\|broker_history`, `live_options_exit_corrected\|broker_history` | operator |
| `live_position_unprotected\|kill_switch` | operator |
| `live_options_exit_reprice_deferred\|mid_fill` | control |
| `daily_halt_alerted` (live and paper) | control |
| `daily_give_back_halted` | control |

`live_position_unprotected|exit_working` stays a defect: the position has no stop for as
long as the app's close rests. A halt tripped by a booking error stays a defect under its
own class (`daily_halt_retracted`). The review rule reads halts from the daily results,
not from these findings.

Every occurrence is still a finding, with its nature and a lever that says whether there
is anything to fix. `findingNeedsAction` is the one test for "counts". Both readers call
it:
- the persisted count behind the Auto page's "N findings";
- the tune advisor's execution recommendations and headline.

A finding with no nature (a scan persisted before this change) counts, which is the old
behaviour.

**Pre-committed check,** after the deploy and a fresh persisted scan
(`GET /journal/edge-leaks?sessions=40&book=both`):
- In `GET /journal/tune-advice`, no execution recommendation's id ends in
  `broker_history`, `kill_switch`, `mid_fill`, `daily_halt_alerted|live`,
  `daily_halt_alerted|paper` or `daily_give_back_halted`.
- The headline's defect count equals the number of current `defect` findings in the
  scan.

**Tests (each mutation-checked):**
- the nature of each class and variant, including a variant the row does not name
  falling back to its action's nature;
- the finding and its lever carry the nature;
- the dashboard counts defects and configuration findings only, and a finding with no
  nature still counts;
- the advisor counts and recommends on defects only, and leads with the tuning headline
  when none is left.
## 2026-09-23 (thirtieth) — an entry the lists never show is booked from the history

DELL's stop filled at 10:47. Its exit was booked at a quote, 19 shares at $551.878
`manual`. The correction pass looks up the entry's orders by the entry's client order id.
It found them in neither the open list nor the history, and was still asking hours later
(`cause: not_listed_yet`). The bracket's leg had been edited by hand in Webull.

Waiting could never settle it. At seven days it would have aged out on the estimate. And
the pass only ever read the history's fills when the entry's combo was listed and no leg
had filled, the hand-sale case. The fills that closed DELL are separate envelopes in the
history, under the legs' own ids, which is exactly what that match reads.

**Fixed:** an estimate whose entry neither list shows goes to the same history match.
- When the fills add up, it is booked with `source: unlisted_entry` and the fill's kind as
  `fillKind` (`outside_bracket` for a stop or target, `broker_history` for a plain sale).
  Which bracket a stop belonged to cannot be told when the entry is not listed, so
  "`outside_bracket`: a bracket that did not hold" would be a guess.
- When nothing adds up, it waits (`not_listed_yet`) inside the seven-day window and ages
  out after it, as before.
- The app's own orders are never matched, and each fill is still booked to one exit.

The scan reads the new source under its own label, `live_exit_corrected|unlisted_entry`.

**Pre-committed check,** on the next pass after the deploy: DELL's exit 709 reads
`live_exit_corrected` with `source: unlisted_entry`, if its fill is still inside the
seven-day history (the entry was placed 2026-09-23, so until 2026-09-30).

**Tests (each mutation-checked):**
- the DELL shape: an unlisted entry is booked from a stop fill in the history, is final,
  writes no skip, and reads under its own label in the scan;
- a plain hand sale on an unlisted entry is booked with its kind and reason;
- an app order in the history is never matched, and the estimate waits and is asked
  again.

**Correction (2026-09-24).** The leg was edited by hand: the operator confirmed it, and the
history shows the stop raised from 548.76 to 552.00, where it filled at 552.04. But the
edit is not why neither list showed the entry. It kept every order's own id, and the
app's reader skipped DELL's three orders together with 39 others on other names, from
09-18 to 09-23: see "2026-09-24 — the order history is read whole". The history match this
section added stays as a backstop. It reads the same pages, so it could not have found
DELL either.

## 2026-09-23 (thirty-first) — the market-direction gate's index leg survives a failed quote

A read-only review of the gate before its first live session found no logic error:
- the lean mapping is right for stocks and options (a put leans short);
- breadth counts every scored universe name by its own quote;
- the loop hands the same reading to both live books.

It found one data failure worth fixing before it acts on real money. The index leg is a
separate `getQuote('SPY')` after the screen, which is the tick's heaviest burst of
provider calls, and `getMarketChangePct` turns every error into null. A null makes the
reading `unknown`, and `unknown` refuses nothing. So one rate-limited quote on a broad red
day let that tick's longs and calls through, while the screen had read SPY's quote
moments earlier.

**Fixed:** the screen reports the index's own quoted move (`ScreenResult.indexChangePct`,
null when the index was not scored). The loop uses it only when the fresh fetch fails.
The `market_direction_read` row carries `indexSource: quote | screen`. With both sources
missing, the reading is `unknown` as before.

> **Superseded 2026-09-24.** The operator approved both of the first two items below on
> 2026-09-23 ("go ahead on that schedule"). They are built in "2026-09-24 (third)": the
> reading now holds inside an exit band, and scale-ins and second lots are gated.

**Not changed, and why:**
- **No latch.** The gate reads afresh every tick and a mixed tick refuses nothing. This is
  deliberate: a market that stops being red lets longs through again, which is what the
  operator asked for. A tick that wobbles across 0.2% / 65% is, by the rule, not
  one-sided. Hysteresis (stay red until breadth falls under the bar minus 5 points) would
  make the gate stickier. It is a change of rule, so it waits for the operator's word
  and for the gate's first refusals.
- **Scale-ins and per-lot second lots are not gated.** Both run before the reading exists
  in the tick. Both are off in production (`liveScaleInEnabled`,
  `livePerLotBracketsEnabled`), so this is written down rather than built. Turning either
  on should come with the gate on its path.
- **Both legs read against the prior close**, so a gap-down day that rallies reads red all
  morning. That is the rule as specified: a red day is measured from yesterday's close.

**Pre-committed check:** every `market_direction_read` row from 2026-09-24 carries
`indexSource`. A row reading `screen` is a fresh-fetch failure the old code would have
read as `unknown`.

**Tests (each mutation-checked):**
- the loop hands both live books a RED reading when the fresh fetch fails and the
  screen saw the index red, and the row says `screen`;
- a fresh fetch that works stays the source;
- with neither source the reading is `unknown`;
- the screen reports the index's quoted move, and null when the index was not scored.

## 2026-09-24 — the order history is read whole

**What happened.** DELL's exit 709 was still booked at a quote after the deploy of the
thirtieth section's fix. The journal could not say why, because a skip is logged once a
day. A read-only probe that can page the order lists by hand (#670) then showed three
things about the broker's history:
- DELL's bracket was in it all along: the entry (19 @ 562.52), the stop that filled
  (19 @ **552.04**) and the cancelled target. The operator had raised that stop by hand
  in Webull, from the app's 548.76 to 552.00. The edit kept the orders' own ids, which is
  how the correction still found the bracket by the entry's id once the pages were read
  whole.
- The app's full read had never returned those three orders, nor 39 others.
- In total, 42 of the history's 176 orders were never read.

**How Webull pages the lists**, measured on the deployed account:
- A page is the `page_size` orders with the highest client order id strictly below the
  cursor, compared as strings.
- Every other order of their groups comes with them, wherever those ids sort.
- Groups are listed by their first order's id.
- Bracket legs carry ids unrelated to the entry's. The app draws a fresh one per leg, and
  Webull's own ids for orders placed in its app have 24 characters, not 32.

Page one of 100 held 128 orders:
- the 100 highest ids, down to `6ab291…`;
- 28 legs and entries pulled in with them, the lowest at `01d3…`.

Each of the 28 had a group member at or above the cut.

**The bug.** The reader passed the page's last envelope as the next cursor. A page
listed in group order ends in a bracket leg as often as not, and its id can sort
anywhere:
- **Below the true cut,** it skipped every order in between. On 2026-09-23 the cursor was
  `38f7…` against a cut of `6ab2…`.
- **Above the cut,** it re-read orders already read. That is the overlap the 2026-09-23
  duplicate fix cleans up.
- **A page that re-listed the previous page's first group** stopped the walk as "the
  server ignored the cursor".

**What the skip hid**, all from the missing 42:
- DELL's bracket.
- SHOP's stagnation close on 2026-09-22 (91 @ 148.34). This was the "ghost" position of
  that evening, which the reconcile never saw fill.
- LITE's stop on 2026-09-21 (21 @ 972.00).
- Sells of SNOW and MRVL on 2026-09-22.
- About 30 option fills. One was the MRNA call's 2.15 close, booked by hand that
  evening. This is the blind spot of the options reconcile, where acknowledged orders were
  "missing from both lists".

Which orders were skipped moved with every new order, so the same order could be missing
on one read and present on the next. That read as the lists "lagging a fill".

**Fixed:** the next cursor is the `page_size`-th highest id below the current one. A
page with fewer ids than that below the cursor is the last. Ids a pulled-in group brings
from above the cursor were read already and do not count. The replay stop is gone:
- a server that ignores the cursor answers with the first page again;
- that page holds no full page below the cursor, so the walk ends;
- every cursor sorts strictly below the last, and the 20-page cap bounds the rest.

The read costs the same two calls it did. It now reads the 176 orders the history holds.

**What this changes.** Every reader of the lists goes through this one function:
- the stock and options reconciles;
- the exit corrections, stock and options;
- the hand-close matchers;
- the fill-race read after a cancel;
- the open-orders read.

Estimates still inside the seven-day window are corrected to their fills on the first
pass after the deploy, and their days are re-recorded.

**Pre-committed check,** on the first correction pass after the deploy: DELL's exit 709
reads `live_exit_corrected` with `source: bracket_leg`, $551.878 → $552.04, and the
2026-09-23 result is re-recorded.

**Tests (each mutation-checked):**
- A fake broker that pages exactly as measured. It serves 45 brackets, 70 single orders,
  both id lengths, and DELL's shape: a bracket on page one only because a leg sorts at
  the top, listed last, ending in a leg near the bottom. Every order is read exactly
  once, and each cursor is the 100th highest id below the one before.
  - The old last-envelope cursor fails it.
  - So does using the 101st highest id instead of the 100th.
- A bracket pulled onto page two is listed first again, and the walk goes on. The old
  replay stop fails it.
- `nextPageCursor` itself:
  - string order with mixed id lengths;
  - ids above the cursor do not count toward a full page;
  - a repeat counts once;
  - a short or empty page is the last.

## 2026-09-24 (second) — a sleeve at its daily order budget stops before it builds an order

**What happened.** The Trade page's recent orders held only rejected option entries: 50
of them between 11:56 and 12:28 on 2026-09-23 (PLTR, CRWD, META, GOOGL), each refused
`max_orders_per_day: 6 placed vs 6/day`. The options sleeve had spent its
`liveOptionsMaxOrdersPerDay` by 11:56. After that it still built every candidate:
- a risk check;
- a quote fetch;
- an account read;
- an order intent;
- a guardrail refusal at the very end, with a `live_options_entry_blocked` row.

It did this every tick until the 12:30 short-dated cutoff. The stock sleeve has the same
shape for `liveMaxOrdersPerDay`.

**Fixed:** each sleeve checks its budget per candidate, after every gate that decides
whether the book wants the trade and before anything costly:
- for stocks, after the market-direction gate and before the level fetch, the
  correlation and sector lookups, the risk check and placement;
- for options, after its market-direction gate and before the correlation lookup and the
  risk check.

The check uses the guardrail's own predicate (`withinDailyOrderCap`, which the
`max_orders_per_day` rule now calls too) with the same count (`countTodaysOrders` for the
sleeve) and the same cap (the sleeve's trading-config builder). So the skip can never
refuse an order the guardrail would pass. The guardrail stays the authority for an order
placed later in the same batch.

A refusal writes `live_order_cap_skipped` (stocks, through `journalDeclinedEntry`, so it
carries entry, stop and side for a replay) or `live_options_order_cap_skipped` (options).
Each is written once per name per day with `ordersToday` and `maxOrdersPerDay`.
- **What is refused is unchanged.** Only the work, and the order rows, stop.
- **The stock row is an attribution class.** The paper book is not held to the cap, so
  its untaken paper R is what the budget costs. The advisor names `liveMaxOrdersPerDay`
  (exposure) as the lever, with the warning that the cap is also the runaway-loop
  backstop.
- **The options row is named as not attributed**, with its reason, in the reachability
  guard.

**Pre-committed check:** on the next day a sleeve reaches its cap, the Trade page's
recent orders show no rejected entries after the cap was reached. Recent activity shows
one `…order_cap_skipped` row per name.

**Tests (each mutation-checked):**
- stock, at the cap:
  - no intent is written;
  - no placement goes out;
  - no per-candidate account read happens;
  - one replayable row per name per day;
  - the existing sleeve-split test now sees the early refusal instead of the
    guardrail's.
- options, at the cap: no intent, no account read, no order, one row a day per name.
- options, one under the cap: the entry goes out.

Removing either pre-check fails its sleeve's tests. Loosening the shared predicate to
`<=` fails both sleeves and the guardrail's own test.

## 2026-09-24 (third) — the market-direction reading holds, and adds are gated

The thirty-first section left two gaps for the operator's word, and the operator
approved both on 2026-09-23:
- the reading judged each tick on its own, so a market near the bar flickered;
- scale-ins and per-lot second lots added shares without asking the gate.

A third gap had the same shape. A tick the reading could not see (`unknown`) refused
nothing. The index-leg fallback in the thirty-first section covers a failed SPY quote,
but not a screen that measured fewer than 100 names.

**What changed.**
- **The exit band.** `holdMarketDirection` (marketDirection.ts) is one pure step: the raw
  reading plus the previous tick's hold. Once red, the reading stays red while SPY is at
  least `marketDirectionExitIndexPct` down and at least `marketDirectionExitBreadthPct` of
  names are red. Green mirrors. Entering still needs the full bar.
  - The band is judged through the same function as the bar (`sideMet`), on the same raw
    figures (`measure`), so it can differ from the bar only in its two numbers.
  - It is never applied stricter than the bar (`min(exit, entry)` per leg).
  - A band of 0 still needs SPY on the day's side of zero, as the bar does.
- **The data-gap hold.** An `unknown` tick keeps the last one-sided reading for up to
  `DIRECTION_DATA_GAP_HOLD_MS` (5 minutes, a little over two ticks) after a readable tick
  last supported it. A gap never extends itself: only a readable tick that meets the bar
  or stays inside the band moves the confirmation time.
- **Neither hold crosses the ET day.** Both legs are measured from the prior close, which
  moves overnight.
- **Neither hold outlives a gap in the reading.** A hold is carried only from a reading
  confirmed in the last `DIRECTION_DATA_GAP_HOLD_MS`. While a kill switch, a stop or a
  macro blackout holds the loop, it returns before its screen and nothing reads the
  tape. Without this bound, the first tick after hours of that, under the bar but inside
  the band, re-confirmed the morning's red. Consecutive ticks refresh a band hold, so
  this bites only across a gap. (Added before merge, on review.)
- **The loop acts on the held reading** (`readMarketDirectionForTick`). A held reading
  carries `heldBy` (`hysteresis` or `data_gap`), `rawDirection`, and the band as applied.
  The refusal rows (`live_market_direction_skipped`, `live_options_market_direction_skipped`)
  carry `heldBy` and `rawDirection` too.
- **Rows are not flips.** The change detector now keys on direction plus hold, so a hold
  starting or ending writes a `market_direction_read` row. A flip is a change of `direction`
  between consecutive rows. The edge-leak scan reads `direction` and is unaffected.
- **Adds are gated.** A scale-in and a per-lot second lot both call
  `addOnDirectionRefusal`, one function for both, with the position's side as the lean.
  - Both run before the tick's screen, so they judge the previous tick's reading
    (`latestMarketDirection`).
  - A reading older than `LATEST_DIRECTION_MAX_AGE_MS` (10 minutes) refuses nothing, the
    same as `unknown`.
  - A scale-in is asked once the trigger and the add-on cap say an add is due. The daily
    halt, the aggregate open-risk cap and the guardrails are asked after the gate, so a
    `live_scale_in_direction_skipped` row can record an add one of those would also have
    refused. Once per position and direction a day. A refused scale-in is asked again the
    next tick, priced and sized afresh.
  - The second lot has its own action rather than `per_lot_second_lot_blocked`, so the
    guardrail's refusals and the gate's can be counted apart.
    `per_lot_second_lot_direction_skipped` **drops the lot for good** (`dropped: true`;
    the row is the marker, read by `positionId`). The lot is the entry's plan, sized at
    entry against the frozen entry stop and meant to follow within a tick. Sent hours
    later it would buy at that moment's price against the same stop, with no aggregate
    risk, cutoff or same-day check: long 34 @ 100, stop 98, a 17-share lot sent at 103.5
    risks $93.50 where the sizer budgeted $34. (Changed before merge, on review.)
  - Both flags are off in production (`liveScaleInEnabled`, `livePerLotBracketsEnabled`,
    read 2026-09-24), so today this changes nothing that trades.
- **Two settings.** `marketDirectionExitIndexPct` (default 0.1, clamped to [0, 5]) and
  `marketDirectionExitBreadthPct` (default 60, clamped to [50, 100]). Each has its zod
  bound and patch line, is in `NEVER_TUNED_KEYS`, is driven through the real PUT in the
  gate's route test, is read by the loop, and has a Settings input beside the bar.

**Calibration.** This used the record the bar came from: 22 sessions, 2026-08-24 to 09-23,
with breadth from minute bars of a 60-name sample. The held reading was replayed every
minute, and each trade placed against it at its entry minute:

| exit band (SPY / breadth)  | label changes a session | undone within 10 min | red minutes | live longs refused | their R | paper longs, same readings | their R |
| -------------------------- | ----------------------- | -------------------- | ----------- | ------------------ | ------- | -------------------------- | ------- |
| none (the bar, 0.2% / 65%) | 10.1                    | 7.0                  | 31%         | 30                 | −6.50   | 24                         | +5.09   |
| 0.15% / 62%                | 5.1                     | 2.3                  | 33%         | 34                 | −5.89   | 26                         | +5.91   |
| 0.1% / 62%                 | 4.9                     | 2.2                  | 33%         | 34                 | −5.89   | 29                         | +6.19   |
| **0.1% / 60%**             | **2.2**                 | **0.55**             | 35%         | 37                 | −5.96   | 30                         | +6.23   |
| 0.05% / 55%                | 1.3                     | 0.27                 | 38%         | 41                 | −5.33   | 33                         | +6.19   |

- **Read every 2 minutes, as the loop does,** the default goes from 7.4 label changes a
  session to 2.0, and the changes undone within 10 minutes from 4.5 to 0.45.
- **The breadth half does the work.** At 60% breadth, index bands of 0.1%, 0.05% and 0 give
  the same count. At 65% breadth, 0.1% barely moves it (9.6).
- **What the band costs.** The default refuses seven more live longs: QCOM, SWKS and DELL
  on 09-15; LITE twice, NOK and SMCI on 09-08. They made +0.54R between them, and their
  paper twins +1.13R. So the band does not save money on this record, and it costs a
  little, inside noise. What it buys is a label that stays put. The scan and the tape
  plan's measurements cut every trade by this label, and a trade entered in a one-minute
  dip of a red morning belongs with the red morning.
- **Caveat.** Breadth from 60 names is noisier than breadth from the ~500 the loop
  measures, so live flicker without the band would be lower than 10.1, and the band has
  less to remove. The first sessions with the band read that directly (the checks below).

**First live session (2026-09-24), read after the close.** The gate ran bar-only (this
change was not deployed yet). It changed label 4 times: mixed from 09:36, red 11:12–12:18,
red again 14:03–14:07, mixed to the close. It refused no live entry: every live entry of
the day was placed by 11:08, before the first red reading. The band at 0.1% / 60% would
have held one of the two exits from red. At 14:07:50, four minutes after the reading
turned red, SPY was −0.16% with 64.1% of the sample red, inside the band. That is the
flicker the band exists for. It would have released the other: at 12:18:28 SPY was back
at +0.02%. Rows are written only on a change, so how long that afternoon hold would have
lasted cannot be read from them, but no live entry was placed after 11:08 for it to
refuse. One session moves nothing: the band stays at 0.1% / 60%, and the checks below
stand.

**Pre-committed checks.**
- **The first session after the deploy.** Every `market_direction_read` row carries the
  band (`exitIndexPct`, `exitBreadthPct`). A held stretch shows as a row with `heldBy`, and
  the Last cycle line reads "held" while it lasts.
- **After 10 refusals made under a hold** (`heldBy` set on the refusal row), read their
  paper twins. The refusal rows are written once per name a day, so a name refused at the
  bar in the morning and under a hold later carries only the first, unheld row. The count
  of held refusals is therefore a floor, not the whole number. If the paper mean has a 95% interval above zero, propose raising
  `marketDirectionExitBreadthPct` to 62. That adds exposure, so it waits for the
  operator's word.
- **After 5 sessions,** count flips (direction changes between consecutive rows, not rows).
  If the mean is above 4 a session, lower the exit breadth to 58, which is the safe
  direction, and read again.

**Tests (each mutation-checked):**
- **The pure step:**
  - it enters on the bar and holds inside the band;
  - it lets go when either leg leaves the band;
  - inclusive edges;
  - a band of 0 still needs SPY red;
  - green mirrors;
  - the band is never stricter than the bar;
  - the data gap holds up to 5 minutes and not a millisecond more, and never extends
    itself;
  - a band hold counts as a confirmation for the gap;
  - no hold crosses the day;
  - a flickering tape changes label once instead of three times.
- **The loop:**
  - it hands the held reading to both live books and journals the hold;
  - raising the exit breadth to 65 lets the same tape go;
  - handing either entry bar in place of its exit setting fails.
- **Adds:**
  - a long scale-in on a red reading places nothing and journals once;
  - it goes through on a mixed reading, with the gate off, or with a reading older than
    10 minutes;
  - a second lot refused while red is journaled once under its own action with
    `dropped: true`, and is not sent when the tape turns; another position's row does
    not drop it;
  - removing the gate from the shared function fails both.
- **Guards:**
  - a held refusal's row says `heldBy`;
  - the route applies both settings and refuses out-of-range values, and dropping a patch
    line fails;
  - the reachability guard fails if the loop stops reading a setting;
  - both new actions are classified in the journal-action guard.

## 2026-09-25 (third) — a filled bracket leg is booked at its fill, not at a quote

**What happened.** A bracket's stop and take-profit are orders of their own. The reconcile
books a leg's fill from the order lists, and the lists show a filled leg late: 4m43s to
5m02s after the sync first found the shares gone (SMCI 2026-09-23, GRML 09-24). The sync's
bracket grace is four minutes (`BRACKET_RECONCILE_GRACE_MS`), so it closed the position at
a live quote, tagged `manual`, and the stock exit correction replaced that with the leg's
fill 30 to 50 seconds later. GRML on 09-24: booked at 15.53, stop filled at 15.39,
corrected 29 seconds on. In between, the day's P&L, the halts and the step-down read the
quote, and the tune advisor counted each correction as an execution defect. The lists'
lag had grown: on 2026-09-21 it was about two minutes, which is what the four-minute grace
was sized for. Order Detail answers for a leg only by the leg's own `client_order_id`.
Asked with the entry's id it returns the MASTER alone. Those ids were minted when the
request was built and then lost with it.

**What changed.**
- **Placement keeps each exit leg's id** (`bracketLegClientOrderIds`, returned by
  `webullPlaceOrder` and `webullPlaceStandaloneBracket` on an accepted AND an unanswered
  placement). The entry bracket's legs go on the entry row (`tp_client_order_id`,
  `sl_client_order_id`). A re-armed bracket's legs replace them when the re-arm succeeds:
  the protection sweep, the scale-out's remainder bracket, and its full-size restore.
  Scale-in add-ons and per-lot second lots keep their own.
- **The reconcile asks the legs directly** (`resolveFilledLegsFromOrderDetail`).
  - It asks for a filled bracket entry whose position is still open and has stored leg
    ids, once the sync has missed the shares at least once (`missStreakOf`).
  - It reads the stop, then the take-profit, by Order Detail: at most four legs a tick.
  - A FILLED answer is folded into the entry's legs, and the code that books a listed leg
    books it. The price is the fill; `stop` or `target` comes from which of the app's own
    ids answered, not from a label in the reply.
  - Journal: `live_bracket_leg_from_detail`, once per order a day. It says which leg filled
    and what the lists still showed.
- **Nothing else moves.** A leg read as working, cancelled or partial books nothing. The
  sync's grace and the correction still cover what this does not settle: a position the
  app did not place, a row placed before this change, a close made by hand.
- **The ratchet.** A position whose stop has filled has no resting stop, and it stays open
  in the ledger until its fill is booked. The ratchet wrote `live_stop_adjust_blocked` on
  that every tick (HOOD 09-18, MRNA 09-22), and the advisor read each as an execution
  defect. When the sync has already missed the shares, it now writes
  `live_stop_adjust_skipped` once a day instead. With the shares still showing, a missing
  stop is blocked as before.

**Timing.** The sync misses the shares during a tick (or during the 60-second background
sync), and the next tick's reconcile asks. So a fill is booked about one tick, roughly two
minutes, after the shares go. The grace waited four minutes and the lists about five. One
miss is enough to ask, where the sync waits for two before it acts: this only reads, and
only a leg the broker itself reports FILLED is booked.

**Tests (each mutation-checked):**
- **Placement:** the extractor returns each leg's own id by combo type, and nothing for a
  plain order. `webullPlaceOrder` returns them on an accepted and an unanswered
  placement. The entry row stores both.
- **The reconcile, end to end** (`autotradeLiveExecute.test.ts`):
  - the stop is booked at the Order Detail fill as `stop`, the take-profit is never asked,
    and one row names the leg and what the lists said;
  - a filled take-profit books as `target`;
  - nothing is asked while the broker still shows the shares;
  - a leg still working books nothing, and both legs are asked, the stop first.
- **Re-arm:** the entry row points at the re-armed bracket's legs.
- **Ratchet:** with the shares missed there is one skip row and no block; without the miss
  a missing stop is still blocked.

Eight mutations, each caught: the miss gate removed, any status booked, the legs' types
swapped, the ids not stored at placement, a re-arm not recorded, the ratchet ignoring the
miss, the answer not folded into the reconcile's statuses, and the extractor's ids swapped.

**Pre-committed check.** Read the first three bracket exits after the deploy. Each should
have a `live_bracket_leg_from_detail` row or a listed-leg booking, and none should be
booked `manual` at a quote and then corrected. A leg booked from the detail at a price the
later lists disagree with is a defect in this read: switch it off by reverting this change
and report it.

