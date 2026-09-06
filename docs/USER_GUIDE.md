# User Guide

A practical, page-by-page guide to using **Stock Trader** — your personal day-trading
& options-trading assistant. This is a **decision-support and tracking** tool: it
screens, scores, sizes, and journals so *you* can make better, more consistent
decisions. It is **not** a signal service, it makes no predictions, and it never
places trades.

> Looking for *how to trade profitably with it*? See the
> **[Strategy Playbook](./STRATEGY_PLAYBOOK.md)**. Looking for a plain-English
> explanation of the Auto-Trade page's risk settings specifically? See
> **[Auto-Trade Risk Settings](./AUTOTRADE_RISK_SETTINGS.md)**. Looking for
> install/config? See the main **[README](../README.md)**.

---

## Contents

1. [Getting started in 3 commands](#getting-started-in-3-commands)
2. [The interface](#the-interface)
3. [Today (dashboard)](#today-dashboard)
4. [Screener](#screener)
5. [Watchlist](#watchlist)
6. [Options](#options)
7. [Trade](#trade)
8. [Positions & P&L](#positions--pl)
9. [Journal & analytics](#journal--analytics)
10. [Alerts](#alerts)
11. [Auto-Trade](#auto-trade)
12. [Settings](#settings)
13. [A recommended daily workflow](#a-recommended-daily-workflow)
14. [Data, privacy & providers](#data-privacy--providers)

---

## Getting started in 3 commands

```bash
npm install      # install all workspaces
npm run seed     # OPTIONAL: load demo trades + a 7-symbol watchlist to explore
npm run dev      # start API (:3001) + web (:5173)
```

Then open **http://localhost:5173**.

- With **no `.env`**, the app runs on **synthetic demo data** — clearly labeled, safe
  to click around, never for real decisions.
- For **free live data with no API key**, set `MARKET_DATA_PROVIDER=yahoo` in
  `server/.env` (see the README for the full provider table).
- The demo seed is **idempotent** — re-running won't duplicate trades. To experience
  the brand-new-user onboarding flow, delete `server/data/stock_app.db` and skip the
  seed.

---

## The interface

Everything lives under one top bar:

| Element | What it does |
|---|---|
| **Nav tabs** | Icon + label for each section: Today · Screener · Watch · Options · Positions · Journal · Alerts. The active tab is highlighted; on narrow screens the labels collapse to icons. |
| **Jump to / ⌘K** | Command palette — fuzzy-jump to any page or symbol. Press `⌘K` (mac) / `Ctrl-K`. |
| **☀/🌙 Theme** | Toggle between dark (default) and light. Your choice is remembered per browser. |
| **🔔 Alerts bell** | Triggered-alert count; quick toggle for background auto-checking. |
| **⚙ Settings** | The consolidated settings page (also reachable from `⌘K → Settings`). |
| **Provider chip** | Shows `live` / `demo` / `not configured`. Click for status + a connection test. |
| **Banner** | A colored strip appears when you're on demo data or the provider isn't configured. |

Every page opens with a **bold title and a one-line subtitle** describing what it's for,
with its primary actions on the right.

**Sortable tables:** the dense data tables (Positions, Journal, Watchlist, Screener)
sort by any column — click a header to sort, click again to flip the direction (blanks
always sort last).

**Collapsible tiles:** most titled sections — across Today, Screener, Watchlist, Options,
Trade, Positions, Journal, Alerts, Auto-Trade, Settings, and this guide's companion About
page — click the header (the ▾/▸ chevron) to collapse or expand it, handy for hiding
sections you don't need right now. Each tile remembers its own collapsed/expanded state
in your browser (per tile, not per page), so it stays that way next time you load the
page. A handful of sections are deliberately left as plain, always-open cards instead —
primary content you're actively working in (an order form, an option chain, a strategy's
leg builder), transient results tied to a single click (a dry-run preview, a "just
triggered" banner), and sections that already have their own show/hide toggle (Screener's
"Filtered out" and "Skipped" lists).

**Keyboard shortcuts:** press `?` anytime for the cheat sheet. Quick-nav GitHub-style —
`g` then `t`/`s`/`w`/`o`/`p`/`j`/`a` jumps to Today / Screener / Watch / Options /
Positions / Journal / Alerts. `n` opens **Log trade** from anywhere, `⌘K` opens the
command palette, `Esc` closes dialogs. (Shortcuts never fire while you're typing.)

**Log a trade from anywhere:** the **+ Log** button in the header (or `n`) opens the
trade form on any page — you don't have to be on Positions.

**Feedback you can trust:** every action confirms itself with a toast (bottom-right).
Destructive actions (delete a trade, delete a snapshot) ask first with a styled
dialog, and many — like deleting a position or removing a watch symbol — offer a
one-click **Undo**. If a page ever hits an unexpected error it shows a small
"something went wrong" card (with **Try again**) instead of a blank screen — the
nav and other tabs keep working.

**Always the latest version:** the footer shows the running build (e.g.
`build 2026-06-26 14:30 UTC`). After a new version ships, the app revalidates
`index.html` on every load and reloads itself once if it's still holding an outdated
bundle, so you don't get stuck on stale code — a manual hard-refresh is rarely needed.
If the app ever looks out of date, check that the footer build matches the latest deploy.

---

## Today (dashboard)

Your at-a-glance morning screen.

- **Collapsible tiles:** every section below — **Today's setups**, **Market regime**,
  **Market movers**, **Needs attention**, **Watchlist**, **Upcoming expirations**,
  **Upcoming catalysts**, and **Latest screener snapshot** — collapses independently (see
  "The interface" above).
- **Stat tiles:** Open P&L, Unrealized, Open positions, Gross exposure, and **Needs
  attention** (a count that turns amber when something wants a decision).
- **Today's setups** — a morning shortlist that **auto-scans once** when you first land
  on Today each session (or hit **Scan** / **↻ Rescan** anytime). It runs the screener
  and ranks your universe. Toggle **Long / Short**, and sort by **Score**, **Gap**, or
  **Rel-vol** to surface the four things people watch at the bell; each row shows the
  score, gap %, relative volume, RSI, and a suggested ATR-based stop, links to the chart,
  and has a **+** to log a trade in that symbol (the form opens with it pre-filled). It's
  a transparent rule-based ranking — **not a buy signal**.
- **Market movers** — top whole-market **gainers / losers / most-active / unusual-volume**
  US stocks (tabbed), across the **Regular / Pre-market / After-hours** session — the
  pre-market view is a **gap scanner** (the % column is the gap). Each row shows relative
  volume (highlighted ≥ 2×), market cap, price, and % change, and links to its chart.
  Optional **min-price** and **min-market-cap** filters narrow to liquid names (nothing's
  excluded by default). Powered by Webull's server-side screeners, so it only appears when
  Webull is configured (distinct from _Today's setups_, which ranks _your_ universe).
- **Market regime** (2026-07-23) — a single **Risk-on / Neutral / Risk-off** read of the
  broad tape, folding four independent, explainable signals: the proxy (SPY) vs its own
  **200-day** and **50-day** averages, market **breadth** (% of your universe trading above
  its own 50-day average), and the proxy's **volatility** (ATR%). Each contributes +1
  (risk-on), −1 (risk-off), or 0; the sum crosses into Risk-on at +2 or Risk-off at −2,
  otherwise Neutral. A signal whose data can't be fetched reads **"no data"** and is left
  out of the score — never counted as a fake neutral. It's **context, not a signal**: it
  does not place, size, or block any trade, and it's cached hourly (regime turns on the
  daily close). Formula details live on the **About** page.
- **Needs attention** panel — positions that hit their stop/target or option exit
  rules, plus any triggered symbol alerts, each linking to where you act. If the check
  itself **fails**, the panel says so and the tile reads `?` instead of `0` — an
  unanswered question, never an all-clear. Silence about your stops means silence, not
  reassurance.
- **Watchlist** mini-view with last price and % change.
- **Upcoming expirations** — your open option positions sorted by days-to-expiry (≤ 7
  days turns amber). Only the five soonest are listed, and if you hold more it says
  **"+ N more expiring options not shown"** with a link to Positions — a contract held
  back because five others expire sooner is exactly the one you'd want named. Day counts
  are **calendar days in your own timezone**, so an option expiring tomorrow reads `1d`
  even late in the evening (it used to read `0d` after ~20:00 ET, because the arithmetic
  was done against UTC midnight). A short position also shows an **assignment risk** badge (2026-07-23)
  when it's deep ITM with essentially no time value left — the same badge and pure
  intrinsic/extrinsic math the Auto page's options tables use, applied here to your own
  logged/imported option positions.
- **Upcoming catalysts** (2026-07-23) — earnings and ex-dividend dates within the next 14
  days, across the union of your **open positions'** underlyings and your **watchlist**,
  soonest first (≤ 7 days turns amber). One place to see what's coming up before you plan
  the day, instead of checking each symbol's page individually. Capped at eight, and it
  tells you how many more fall in the window.
- **Latest screener snapshot** — the most recent run you saved.
- **Getting started** — a dismissible checklist for new accounts (build a watchlist →
  run the screener → log a trade → set an alert). It reflects your *real* progress and
  disappears once all four are done.
- **Daily guardrails** — appears only if you've set a daily loss limit or trade cap in
  Settings. Shows today's booked P&L and new-trade count, and turns red to nudge you to
  step away once a limit is reached.

---

## Screener

Rank a universe of symbols by a transparent, fully configurable rule set. **Nothing is
a black box** — every score can be traced to a formula. The universe ships seeded with
the full S&P 500 (500+ symbols); use **Manage universe** to add or remove symbols —
this is the same persistent list Auto-Trade's screener draws from.

### Running it

1. Open **Screener** and click **Run screener** (`Scanning…` while it works).
2. Results are ranked by **total score (0–100)**, the weighted average of six
   sub-scores:

   | Component | Default weight | Measures |
   |---|---:|---|
   | **Momentum** | 30 | Day's % change + distance above/below the 20- & 50-period MAs (±5% ≈ full score; mirrored for shorts). |
   | **Rel. Volume** | 20 | Today's volume ÷ recent average (0.5× → 0, 2× → 100). |
   | **Trend** | 15 | How many of three align: price vs 20MA, price vs 50MA, 20MA vs 50MA (0/33/67/100). |
   | **RSI** | 15 | Closeness to a direction-aware sweet spot (60 long / 40 short) within a ±25 band. |
   | **Volatility (ATR%)** | 10 | Average True Range as % of price (5% ≈ full score; rewards tradeable range). |
   | **Gap** | 10 | Overnight gap *in the trade's favor* (3% ≈ full score). |

3. **Expand any row** to see the full breakdown — raw value, sub-score, weight, and
   contribution for every component.

### Filters vs. score

Filters (price, average volume, RSI band, trend alignment — daily and weekly) are
applied **separately** from scoring. A symbol can score well yet be flagged as *not
passing* your filters, with the reasons shown. Toggle **"Include filtered-out (full
breakdown)"** to see everything, including why each was excluded.

### Direction, presets & config

- Switch between **long** and **short** — the scoring mirrors itself.
- All weights, periods, and scales are **editable**, and you can **save presets** to
  reuse a configuration.

### Sector rotation (2026-07-23)

A collapsible **Sector rotation** panel in the sidebar ranks your universe's sectors
by the **median relative strength** of their members over a 20-day lookback — each
member's own return minus the benchmark's (**SPY**) over the same window, then the
**median** across the sector (so one runaway name can't carry a whole sector).
Strongest sectors sit on top, with a green/red bar and the median figure. **Click any
sector** to load its member symbols into the custom-symbols box and scan just those —
the leaderboard doubles as navigation, so you can go from "Tech is leading" to a scored
list of tech names in one click. If SPY's own history can't be fetched, the board
**falls back to ranking by absolute return** and says so; sectors with no fetchable
history are listed, never ranked zero. Cached hourly (momentum turns on the daily
close). Like the rest of the screener it's a **transparent ranking, not a buy signal**.

### Snapshots & the Edge Report (this is the profitability engine)

- Click **Save snapshot** to freeze the current ranked picks with their prices.
- Click **Snapshots** to open the history. Over time the app computes an **Edge
  Report**: the **forward return** of each pick (direction-adjusted, from snapshot
  price to now), a **hit rate**, and a breakdown **by rank tier** — so you can answer
  the only question that matters: *do my top-ranked picks actually outperform the
  lower ones?* If higher tiers don't out-return lower tiers, your rules have no edge
  yet — re-weight and try again.

---

## Watchlist

A server-saved list of symbols you're tracking.

- Type a ticker and **Add** (or press Enter). Remove with the **✕** (with **Undo**).
- Each row shows last, % change, bid/ask, and volume.
- You can also add symbols from a symbol's detail page (the ☆).

> **Symbol page → News & analysts.** A symbol's detail page shows recent **headlines**
> (Yahoo) with publisher and time, linking out — the catalyst context behind a move — plus
> an **Analyst** block: consensus **price target** (with upside/downside vs the last price),
> rating, and recent **upgrades/downgrades** (firm + grade change), which are themselves
> intraday catalysts. Works on any provider; decision-support, not advice.

---

## Options

Four tabs: **Chain**, **Entry scan**, **Exit rules**, **Strategy**. (Requires a
provider that exposes option chains — e.g. Tradier; demo mode also works.)

> **Timing banner.** When you pick a symbol + expiry, a banner reads the **IV-rank +
> earnings** context: _Rich IV_ (rank ≥ 50, no earnings before expiry → selling premium
> tends to be favored), _Cheap IV_ (rank ≤ 25 → buying premium), or **Event risk** when
> earnings fall before expiry (IV-crush caution). Decision-support, not advice.
>
> If the **earnings lookup itself fails**, the banner shows **Event risk** and says so,
> rather than falling through to _Rich IV_ — which would have asserted "no earnings fall
> before expiry" without having checked, and recommended selling premium into an event
> that could crush it. An unanswered question is treated as risk, not as a clear. If the
> **IV lookup** fails the banner says that too, instead of disappearing.

### Chain

The full option chain for a symbol + expiration, with **Greeks** (delta, gamma, theta,
vega), **IV**, and bid/ask. When a provider doesn't return Greeks, they're computed
with **Black–Scholes** (estimates — European exercise, no dividends, constant vol).

Each row's **Trade** link hands that contract to the **Trade** page — it prefills the order
builder with the contract's symbol, expiry, strike, type, and mark (as the limit), as a
single-leg **buy** you can adjust before previewing/placing.

> **Live quote overlay (Webull/OPRA).** When Webull is configured, **click any contract
> row** to overlay a **real-time** quote on it — bid/ask with sizes, last, mark, spread,
> volume, open interest, IV and Greeks — from Webull's OPRA options feed. The chain
> itself is Yahoo-sourced and usually **delayed ~15 min**, so each live stat shows the
> chain's delayed value beneath it (`chain …`) for an at-a-glance comparison. The panel
> auto-refreshes every few seconds while it's open. (Requires Webull keys + an options
> market-data entitlement; otherwise rows aren't clickable.)

### Entry scan

Give it a target profile and it **ranks candidate contracts** for you:

- **Side** (call/put), **delta band** (`deltaMin`/`deltaMax`), **max spread %**,
  **min open interest / volume**, **DTE window**, and **IV / IV-rank** bounds.
- Candidates are scored by **spread tightness**, **liquidity**, and **delta fit**
  (weights you control), with the full rule breakdown shown.
- **IV context** is included: today's at-the-money IV and its **IV rank** (where it
  sits in its own recent range), so you know if options are relatively cheap or rich.

### Exit rules

Evaluate exit logic against your **open option positions**:

- **Take-profit %**, **stop-loss %**, **time exit** (days before expiry), and **delta
  drift** band. The engine tells you which rule (if any) is currently triggered. These
  same rules feed the proactive exit alerts (see [Alerts](#alerts)).

### Strategy (multi-leg builder)

Build **verticals, straddles, strangles, iron condors, or a custom combo** and see the
whole risk picture before you commit: net **debit/credit**, a **payoff diagram**,
**breakevens**, **max profit/loss**, **combined Greeks**, a lognormal
**probability-of-profit (POP)**, and (2026-07-23) an **expected value** — the same
lognormal model's probability-weighted average P&L at expiration, in dollars. Use it to
compare structures (e.g. a debit spread vs a naked long call) on risk-defined terms; a
structure with a lower POP can still have a higher EV if its payoff is more favorably
skewed, which POP alone can't show.

Once you've built a single leg or a 2-leg vertical, **Trade this structure →** hands it to the
**Trade** page — it prefills the order builder with the strategy and each leg's buy/sell, call/put,
and strike. The analyzer carries no symbol or expiry, so you set those (the chain picker fills real
strikes); other structures (straddles, iron condors) aren't live-placeable yet.

### Roll analyzer (2026-07-23)

Also on the **Strategy** tab, below the builder. Answers "should I roll this option, and to
what?" — compare the position you hold today against a candidate replacement (same side and
quantity; a roll keeps your directional bet, it doesn't flip it):

- Enter the **current** contract (type, strike, DTE, premium) and the contract you'd **roll
  to**, plus the underlying price, side, and quantity. IV is optional per leg — omit it and
  the same solver the Strategy Builder uses backs it out of the premium.
- **Net debit/credit to roll** — the cash flow of closing the old contract and opening the
  new one as a single transaction.
- Side-by-side **breakeven, max profit/loss, probability of profit, and expected value**
  for the current position vs. after the roll, plus the **shift** in each — so you can see
  at a glance whether the roll actually improves your odds, not just whether it costs money.
  Breakeven shift has no universal "better" direction (it depends on call/put and long/short),
  so read it alongside the probability-of-profit and expected-value shifts, which always do:
  higher is better for both.

Decision-support only — like the Strategy Builder, it never places the roll; place it
yourself once you've decided.

### Key option terms

- **Delta** ≈ price move per $1 of underlying, and a rough probability of finishing
  in-the-money. **POP** = probability of profit (a lognormal estimate). **IV rank** =
  0–100% position of current IV within its history. (Full glossary on the in-app
  **About** page.)

---

## Trade

> **Placing a real order takes four locks at once.** This page checks an order against the
> live-trading guardrails in `docs/LIVE_TRADING_DESIGN.md`, then can place it. **Dry-run** and
> **Preview (live)** place nothing; **Place order** submits a real order only when the server
> env `TRADING_ENABLED` is set, every guardrail passes, the kill switch is off, and you
> type-to-confirm. Off by default. Stocks and **single-leg options** (one order at a time).

- **Compose an order** — symbol, stock/option, buy/sell, open/close, quantity, order **type**
  (**Limit / Market / Stop / Stop-limit**), **session** (+ strike/expiry for options), plus a
  reference price used for notional and the fat-finger check. **Stop** triggers a market order at
  your **stop (trigger) price**; **Stop-limit** triggers a limit order (needs both a stop and a
  limit price). Options support every type **except market**. For a limit order the server
  re-derives that reference from **fresh** market data and ignores yours, so the check can't be
  spoofed away — but only when the data really is fresh: if the provider is down and the only
  price available comes from the local cache (which has no age limit), the cached number is
  discarded rather than used, and the fat-finger check falls back to your own reference (or to
  a warning if you gave none). A price of unknown age deciding whether today's limit is sane is
  worse than no reference at all. One allowance, added 2026-09-06: **one tick is
  free** — the check measures how far past a tick the limit sits, not how far past the reference.
  Options under $3 of premium quote in **nickels**, so on a $0.20 mark the nearest price you can
  even express is 25% away, and a percentage band alone would refuse the only sayable price.
  Everything beyond that tick is still judged on the percentage, so a genuinely absurd limit is
  still blocked.
- **Bracket** (stock **and single-leg option** limit orders) — optionally attach a **take-profit**
  and/or **stop-loss** that fire as the entry fills (Webull MASTER + STOP_PROFIT/STOP_LOSS, one
  cancels the other). For a buy, take-profit sits **above** the entry and stop-loss **below** (for an
  option, relative to the per-contract premium); a `bracket_prices` guardrail blocks an inverted pair
  and brackets on spreads. The option bracket body is inferred — **Preview (live)** validates it
  before placing.
- **Option strategy** — **Single** (one leg, the default), **Vertical** (a 2-leg spread), **Covered** (a buy-write), or **Condor** (a 4-leg iron condor).
  **Strikes and expiries are picked from the live option chain** — dropdowns populated for the
  entered symbol (they fall back to free text if no chain is available, so you're never blocked).
  For a multi-leg order, a **Suggest from marks** link fills the **Net limit** and **Side** from the
  live chain marks (sum of leg mids; debit → Buy, credit → Sell) — you can still override it.
  For a vertical you set each leg's buy/sell, call/put and strike, plus one **shared expiry** for
  the spread (distinct strikes, one buy + one sell); the single **Spreads** count and **Net limit**
  apply to the whole spread (so there's no separate per-leg quantity). Order **Side** is the net direction
  (debit = Buy). A `spread_legs` guardrail checks the shape; the spread is valued at its net
  (Spreads × 100 × Net limit) and treated as defined-risk. **Spreads require an approved margin
  account** — Webull rejects debit/credit spreads on **cash** or **IRA** accounts at placement
  (you can still dry-run and preview); the builder shows this reminder when you pick **Vertical**,
  and **Preview (live)** blocks the spread up front (a `spread_account_type` guardrail) when it
  detects a cash/IRA account, so you don't reach a broker rejection.
  **Covered** is a buy-write: it buys **100 × Contracts** shares and sells one call against them as a
  single Webull `COVERED_STOCK` order. **Net limit** is the net debit (stock − premium) per share and
  **Side** stays **Buy**; a `covered_legs` guardrail checks the single short-call leg, and it's treated
  as defined-risk like a vertical. The order body is **inferred from the vertical/COVERED_STOCK
  envelope and confirmed via Preview (live)** before placing.
  **Condor** is a 4-leg **iron condor** — a put credit spread + a call credit spread (sell + buy puts
  below, sell + buy calls above), same expiry, distinct strikes. **Net limit** is the net credit and
  **Side** is the net direction (credit = Sell); an `iron_condor_legs` guardrail checks the shape, it's
  defined-risk, and (like a vertical) it needs a **margin account**. The body is inferred from the same
  broker-confirmed envelope and validated via **Preview (live)**.
- **Session** — **Regular** (core hours, the default), **Extended** (pre/post-market), or
  **Overnight**. Outside regular hours the broker only accepts **limit** orders, and the symbol
  must be eligible for that session on Webull — otherwise the order is rejected. (Maps to
  Webull's `support_trading_session` = `CORE` / `ALL` / `NIGHT`.)
- **Dry-run (manual state)** — enter buying power, exposure, today's P&L, orders today, and
  your current position by hand, then check the guardrails. A banner reads **would submit** or
  **blocked**, with the **notional**, audited intent **state**, and the full **guardrail
  breakdown** (✓ pass / ✕ blocked / ⚠ warn, hover for detail).
- **Pull from Webull** — fill the account-state form with your real buying power / exposure /
  position (read-only). Once a **Cash account_id** is set, this also happens automatically every
  **1 minute** in the background, so the tile stays current without re-pressing the button. A
  background refresh is skipped whenever the fields no longer match the last pull — e.g. you're
  mid-edit on a **Dry-run (manual state)** hypothetical — so it never overwrites hand-typed test
  values.
- **Preview (live)** — paste your cash `account_id`; this pulls your real account, runs the
  guardrails against it, and (kill switch permitting) fetches the **broker's cost estimate**.
  Places nothing. For options it also **validates the exact contract** with the broker (a bad
  strike/expiry is rejected here, before you can place). A **⚠ market_hours** warning (and a
  banner) appears when US regular hours (**9:30 a.m.–4:00 p.m. ET**) are closed — options can't
  fill outside them, and a regular-session stock order will wait for the open. It's a warning,
  not a block (the broker is the final authority); off-hours stock orders you've set to
  Extended/Overnight don't trigger it. A **⚠ settled_cash** warning (2026-07-19) appears when a
  buy's notional exceeds your account's **settled cash** — a cash account risks a Good Faith
  Violation if you sell a position bought with proceeds that haven't cleared yet (T+1) before
  that funding trade settles. Also just a warning, since exact GFV detection would need
  per-trade settlement-date tracking this app doesn't keep; it flags the risk rather than
  guessing at it.
- **Place order** — appears only when a live preview **would submit**. Type the shown phrase
  (e.g. `BUY 1 NUVB`) to arm, then place. The **server** re-pulls your account, re-runs every
  guardrail, checks the kill switch + `TRADING_ENABLED`, and writes the intent + broker
  `order_id` to the audit trail. One order at a time — stock, or a **single-leg option**
  (call/put + strike + expiry; limit or stop types — Webull has no market options).
  If the broker **never answers** (a timeout, a network drop, a 429 or a 5xx), you get an
  amber **⚠ Outcome unknown** result rather than a red "not placed": the request may well
  have arrived and been accepted, so the app refuses to claim a rejection it can't verify.
  The order stays in the list as **submitted** and is resolved by **Refresh status** /
  **Refresh all**, which look it up by the client order id the app generated — no broker
  order id needed. **Don't place it again until it resolves**; if it stays unresolved,
  check the order directly at your broker. (Only a definite refusal — a 4xx, e.g.
  insufficient buying power — is recorded as rejected.) Autotrade's own orders resolve the
  same way, and it waits several minutes before concluding an unanswered order never landed:
  concluding that too early would release the guard that stops it placing the same order
  twice.
- **Orders** — recent intents (placed + dry-run), newest first, with their lifecycle state. A
  multi-leg or bracketed order carries a small **strategy tag** (`vertical` / `covered` / `condor` /
  `bracket`) so the row explains itself. For an order that reached the broker, **Refresh status**
  pulls the live broker status by your order id and advances the intent to **filled / partially
  filled / cancelled / expired** (writing the fill price into the audit trail). Single-leg/stock fills
  also flow into the **Positions ledger**: an **open** fill is **auto-recorded as a Position**, and a
  **close** fill **records an exit** against the matching open position(s) — oldest lot first (FIFO),
  a sell-to-close reducing a long and a buy-to-close a short — so the Journal's realized P&L tracks
  live trades automatically. (Spreads aren't auto-tracked — their single-leg fields are null.)
  **Partial fills are recorded as they happen**, not only once an order completes: each instalment
  is booked as its own lot at its own fill price, and the refresh line says how much it booked
  (`partial_filled · 30/100 · booked 30 to Positions`). This matters most when a partly-filled
  order is then **cancelled** — those shares are real, and they're now tracked instead of being
  held invisibly. Refreshing the same order repeatedly is safe: only the not-yet-recorded part is
  ever added. If the broker reports something the ledger can't fully mirror — more filled than you
  ordered, say — the refresh line shows a **⚠ warning** explaining what was and wasn't recorded
  (and **Refresh all** flags how many orders need a look), and the reason is written to the order's
  audit trail. The app deliberately records **less** than it's unsure of rather than inventing
  shares you don't own, so treat a warning as "check this order against your broker".
  **Cancel** appears on an order that's still working
  (acknowledged / partially filled): it requests a broker cancel, then reconciles to show the
  result. Cancel is risk-reducing, so it works even when `TRADING_ENABLED` is off. **Modify**
  changes a working order's **quantity / limit price** in place (Webull "replace"); because a
  modify can _increase_ exposure it's gated like placing — `TRADING_ENABLED` plus the guardrails
  re-run against the new values — then reconciled. Modify is offered only for a **single-leg**
  order (stock or single option): a spread or a bracket is one _combo_ of broker orders, so the
  in-place replace can't safely retune it — change it by **Cancel**-and-re-place instead (the
  server refuses a spread/bracket modify for the same reason). A modify whose response is
  **lost** is reported as **unknown**, not rejected, for the same reason a placement is: it may
  have applied. Nothing is written to the order either way — instead it's re-checked against the
  broker, and if the broker's own record shows a different quantity than the app has, the app
  **adopts the broker's number** and notes the correction in the audit trail. That matters
  because fills are only ever booked up to the order's recorded quantity, so a silently-applied
  size increase would otherwise leave the extra shares untrackable.

### Guardrail config

The side panel persists your safety settings (server-side):

- **Kill switch** — a one-click sticky halt; while engaged, every dry-run is blocked.
- **Trading enabled** — the in-app arming switch (the `trading_enabled` guardrail). This is
  **separate from** the server env `TRADING_ENABLED`: the env var gates the whole deployment,
  while this checkbox arms placement at runtime. **Both must be on** to place — setting the env
  var alone still leaves `trading_enabled` ✕ in the preview until you check this and **Save**.
- **Allow naked short**, and the caps: **max order $**, **max symbol qty**, **max exposure $**,
  **max orders/day** (counts only ENTRY orders that reached the market — broker-rejected
  orders don't burn a slot, and neither do closes. The cap is a runaway-loop backstop, and
  a runaway loop places entries; refusing an exit doesn't limit risk, it strands you in a
  position. Before 2026-08-25 closes counted too, and it showed: one live position was
  carried overnight after its exit was refused 44 times, and another was held 86 minutes
  past its exit — sliding from −$11.41 to −$23.94 — because a stale exit and its
  replacement had between them eaten two of the day's slots. **A close is now never
  blocked by this cap and never consumes it**), **max daily loss $**, **fat-finger %**. A sell that this toggle actually permits to
  open or extend a short submits Webull's own distinct SHORT side (not a plain SELL), so the
  broker's real-time locate/borrow check runs at order time — a symbol it can't currently borrow
  is rejected there, with the reason shown alongside the blocked/rejected order.

Defaults are intentionally tiny and trading ships **off**. The rules: per-order notional,
buying power (buys only), exposure ceiling (opening adds, closing doesn't), per-symbol size,
daily-loss halt, max orders/day, fat-finger price sanity, naked-short block, a spreads-need-margin
check (cash/IRA accounts can't trade spreads), limit/stop price
presence, a session/order-type check (extended & overnight sessions are limit-only), an
options-have-no-market-order check, and the enabled/kill-switch gates — anything that can't be
verified **fails closed**.

> **What "daily loss" measures (2026-07-28).** Webull's day-P&L field turned out to
> include unrealized marks (confirmed with a live watch: it moved 1:1 with open
> positions while no orders were placed) — read naively, an open **gain** could mask a
> real realized loss and the halt would never fire. On the live path the halt now
> takes the **worse** of two realized estimates: the broker's day P&L **minus** its
> unrealized component (account-wide, so it sees trades placed in the Webull app too),
> and the app's **own exits booked today**. Open positions moving against you still
> don't count as "lost" — but a real realized loss can no longer hide behind an open
> winner. The two estimates cover each other's blind spots; when they disagree, the
> halt believes the worse one.

---

## Positions & P&L

Log trades, size them by risk, manage them, and track live P&L.

> **Earnings awareness.** Open positions and the symbol page show an **earnings badge**
> (e.g. `ER 4d`) when a company reports soon — amber inside a week — plus the ex-dividend
> date. It's the classic guardrail against holding options into **IV crush** or getting
> gap-surprised. Dates come from Yahoo (works regardless of your market-data provider).

### Logging a trade (`+ Log trade`)

Open it with the header **+ Log** button or `n`. Stock or option, with: symbol, side,
quantity, entry price/premium, date, an **optional entry time** (enables the time-of-day
breakdown in the journal), fees, (option) type/strike/expiration, **tags** (click a
suggestion chip to reuse a tag you've used before), **grade (A–F)**, **notes**, an
optional **stop** and **target**, and the **pre-trade checklist** (below).

### Size by risk (the most important button)

Inside the log form, expand **+ Size by risk** (or use **Calc size**). Give it your
**account size**, **risk %**, **entry**, and **stop**, and it computes:

- **Suggested quantity** = `floor( (accountSize × risk%) ÷ riskPerUnit )`, where
  `riskPerUnit = |entry − stop| × multiplier`.
- The position's **dollar risk**, **cost**, and **% of account**, plus **warnings**
  (e.g. stop on the wrong side of entry, risk budget too small for one unit, cost
  exceeds account).
- If you have enough trade history, it also surfaces a **history-based suggestion**
  (quarter-Kelly from your realized edge — see [Journal](#journal--analytics)).

Click **Apply** to drop the suggested size into the form.

The standalone **Position-size calculator** (the **Calc size** button on Positions) adds a
**Vertical spread** mode for defined-risk spreads, which have no price stop. Pick **Debit**
or **Credit**, enter the **width** (strike gap) and the **net premium**, and it sizes by the
spread's _capped max loss_:

- **Debit** spread → max loss = `net debit`, max profit = `width − net debit`.
- **Credit** spread → max loss = `width − net credit`, max profit = `net credit`.

**Suggested spreads** = `floor( (accountSize × risk%) ÷ (maxLossPerSpread × 100) )`, and it
shows the position's total **max loss / max profit**, the **reward : risk** ratio, and max
loss as a **% of account** — with warnings for impossible inputs (e.g. a net credit larger
than the width). Decision-support only; it never places the spread.

### The pre-trade checklist

A short, editable list of discipline rules you tick before logging an entry ("Trade
fits my plan", "Risk within budget", "Exit plan defined", …). The result is **saved
with the trade**, so the Journal can later show whether your *disciplined* trades
actually outperform your *sloppy* ones. Edit the rules here or in **Settings**. It's a
nudge, not a blocker — you can still save with items unchecked.

### Managing open trades

- The **open positions table** shows live price, realized/unrealized, total P&L, and
  return.
- When a position has a stop/target, the row shows a **management line**: distance to
  stop (SL) and target (TP), plus the trade's **current open P&L in R** (`+1.4R`) — so
  you always know how the trade is doing *relative to what you risked*.
- **exit** records a (partial or full) exit — a **journal entry only, no broker order**.
  Available on **every** open position, including broker-tracked (live/Webull) ones: use it
  when you've **already sold a position outside the app** (directly in the Webull app, or in
  an account the sync doesn't cover) and just want to record the exit, rather than place a
  redundant real order or delete the row and lose its P&L. (Before 2026-07-23 a live position
  only offered **close**, leaving no clean way to log an already-sold one.) The exit **date
  picker won't go below the entry date** — an exit before the entry yields negative hold-days
  and a negative wash-sale window, and the server rejects it anyway. A $0 exit price is
  allowed for an **option** (that's what expiring worthless looks like) but refused for a
  **stock**, where it would quietly book a full-loss realized P&L.
- **close** (broker-tracked positions only — imported from Webull, opened by a live fill, or
  linked to a live order) instead places a **real closing order** at your broker: full
  remaining quantity, a marketable-limit price near the current market, cancelling any
  resting stop/target first — and **refusing to place** if it can't confirm that stop is
  gone (an unreadable open-order list, an unidentifiable order on the symbol, or a race
  check that couldn't run), since a close placed next to a working stop can fill twice
  and leave a long **short**. Gated by the same type-to-confirm phrase (`SELL <qty>
  <symbol>` / `BUY <qty> <symbol>`) as any other live order on the [Trade](#trade) page —
  type it, enter your Webull cash account_id (remembered from Trade), and the server
  re-checks `TRADING_ENABLED`, every guardrail, and the kill switch before it fires. The
  order can take a few minutes to fill; the position updates once it does (automatically,
  via the same background Webull sync that reconciles any other live order). If the broker
  never answers, you get the same amber **⚠ Outcome unknown** result described under
  [Trade](#trade) — **don't close again until it resolves**, since a first close that
  actually went through would leave the second one overselling (for a long, flipping you
  short). For an **option** with no live bid/ask, the limit falls back to the contract's
  last **trade**, which can be hours or days old; the close is still placed (refusing would
  leave you with no way to close it from here) but flagged with an amber warning, because a
  stale-high print puts the sell limit above where the contract can actually be sold and
  the order may simply rest unfilled. Use **close** when you still hold the position and
  want the app to sell it; use **exit** when you've already sold it elsewhere.
  > **If a close is refused after your bracket was cancelled, read the red box.** The
  > close has to cancel a resting stop/target *first* — otherwise it could fill next to a
  > working stop and sell your position twice. So when the close is then blocked (a
  > guardrail, the kill switch, an unusable quote), that cancel has **already happened**:
  > the position is still open and **no longer protected**. The dialog now says so
  > explicitly, because "✕ Not placed" on its own reads as "nothing changed". Either close
  > again or re-place the stop at your broker.
- **Expired options** — an option held **through** expiry never produces a closing order,
  so nothing ever records an exit and the position would sit "open" forever, quietly
  inflating your open exposure, position count, risk caps and unrealized P&L with a contract
  that no longer exists. When any open option's expiry has passed, a banner appears at the
  top of the page listing them, split into two groups:
  - Ones that **expired worthless** (the underlying finished clearly out of the money on the
    expiry date). One button records a **$0 exit** for all of them, dated on the **expiry
    itself** rather than today — so the realized loss lands in the period it actually
    belongs to. Nothing is written until you press it: $0 exits change your realized P&L in
    both the Journal and the CSV/tax export, so it's a deliberate action, not a background one.
  - Ones that need **you** — finished **in the money** (so it was exercised or assigned,
    which creates or removes a *stock* position this app doesn't track), or too close to the
    strike to call, or with no price available for that date. These are **never** closed
    automatically; the banner explains why for each, and you record the real outcome with
    **exit** (or delete the row if the trade never happened). Guessing here would write a
    realized P&L number that never occurred, which is worse than a row you can see is stale.
  Positions on their own expiration day are left alone — they're still tradeable all session.

  Auto-trade's **live options book** keeps its own table and gets the same treatment from a
  background sweep, with one difference: it acts without a button, because a stuck row there
  consumes shared aggregate-risk headroom and a concurrent-position slot from the *equity*
  book too. Clearly-worthless contracts are closed at $0 automatically; anything in the money
  or unpriceable is **never** closed and instead **pushes you a notification** (2026-09-05) —
  an in-the-money expiry was exercised or assigned, so the account may hold stock the app
  doesn't track, and that tends to happen at Friday's close when nobody is reading a journal.
  The push fires once per position, not once per loop tick.
  An expired-but-open option shows `—` in the Price column: an expired contract has no live
  mark, and the app no longer asks a provider for one (2026-07-28 — the provider would
  silently substitute the *nearest live* chain, where the same strike usually still matches,
  so the dead contract used to show a fabricated "current price").
  > **The background sync closes broker-dropped worthless expiries itself (2026-07-28).**
  > While Webull still *lists* an expired contract (settlement lag), closing it is the
  > banner's manual button, as above. But once the broker **drops** it from your holdings,
  > the position sync treats that like any other broker-confirmed close — except an expired
  > contract can't be priced from a live quote (that's what left these **stuck open
  > forever**, retrying a price that would never exist, which is exactly how "my expired
  > positions never leave the page" happened). It now reuses the sweep's classification:
  > unambiguously **worthless** → closed automatically at **$0 dated on the expiry**, logged
  > on **Recent activity** like every other broker-truth close; **in the money / too close
  > to call / unpriceable** → left open for you, with a one-time Recent-activity entry
  > pointing at this banner. Same conservative split, just no longer requiring a button
  > press for the case with only one honest answer.
  > **Why an expired contract used to keep coming back.** Webull keeps an expired option in
  > your holdings until settlement clears — over a weekend, that's all of Saturday and
  > Sunday. The sweep would close it at $0, and the next position sync (every 5 minutes)
  > would see it still listed at the broker, find no *open* journal row matching it, and
  > import it again as a brand-new position — which the sweep would then close at $0 too,
  > **booking the same loss twice**. Deleting the duplicate didn't help; the next sync
  > re-added it. Since 2026-07-26 the import refuses any contract whose expiration has
  > already passed (you can't newly open an expired contract), so the loop can't start. A
  > contract expiring *today* still imports normally.
- **journal** edits tags/grade/notes, the **entry date**, and (2026-07-17) which
  **Webull account** the lot lives in — shown as a small chip next to the symbol whenever it's set, so you can tell
  positions in different real accounts (e.g. cash vs. margin) apart at a glance. The same
  dialog lists the position's **exits** with a **remove** button on each — deletes that
  exit and reopens the position for the quantity it closed; use this to undo a mistaken or
  incorrect exit entry (including one the Webull sync below auto-recorded against the
  wrong account, before this fix). If a save or an exit removal **fails**, the dialog says
  why and stays open with your edits — it no longer closes silently as though it worked.
- **del** removes the whole position (with confirm + Undo). A delete or undo that fails
  now tells you so rather than looking like it succeeded.
- **Open / Closed / All** filter which rows the table lists; the headline tiles and the
  panels below always describe the **whole** book. When a tab is empty but the book isn't,
  the table says so (with a **Show all**) instead of showing the first-run "log your first
  trade" prompt.
- **Refreshing.** Two different things refresh, on purpose. The auto-poll and the
  **Refresh** button re-read **prices** — cheap, once a minute by default, and skipped
  entirely while the tab is in the background (it catches up the moment you come back, so
  you never read stale numbers). The panels below — stress test, correlation, expired
  options — recompute when the **book itself** changes (an exit, a close, a delete, a
  logged trade), because each costs a per-symbol data lookup and none of them move just
  because prices did. Before 2026-07-26 they were wired to nothing and simply never
  refreshed, so they kept describing a book you had already changed. Since 2026-07-28 that
  includes changes made **server-side**: when a poll comes back with a different book —
  the background Webull sync closed a sold or expired position, a live order filled — the
  panels notice and recompute too, instead of waiting for you to touch something on the
  page. A poll that moved nothing but prices still leaves them alone.
- **When a refresh fails** (the page auto-polls every minute by default), the table keeps
  showing the numbers that last loaded and flags it with an amber banner — the last-known
  P&L is exactly what you still want on screen. The **Updated** clock only advances on a
  refresh that actually succeeded, so its age is always the true age of what you're looking
  at. Only a failure with nothing loaded yet replaces the table with an error.
- An **Exposure panel** summarizes gross/net exposure across the book. A partially-exited
  position counts at what's **still open**, never the whole original lot.
- A **Market stress test** panel (2026-07-23, collapsed by default — click to load) shows
  estimated P&L for a small set of hypothetical broad-market moves (−10% / −5% / −2% / 0 /
  +2% / +5% / +10%), beta-weighting every open stock and option position by its own beta
  (from your market-data provider) against its current market value (stocks) or its live
  delta and underlying price (options). Positions whose beta, price, or delta can't be
  resolved are **excluded and listed**, never assumed zero-risk — the panel says plainly
  when its coverage is partial. A model of sensitivity, not a prediction: real market moves
  aren't linear and beta drifts over time.
- **Closed positions** show a `—` in the Price column rather than a live mark. Nothing is
  left open, so their P&L is entirely realized either way, and pricing an expired contract
  costs a data request per refresh to learn nothing.
- A **Correlation heatmap** panel (2026-07-23, collapsed by default — click to load) shows a
  pairwise **Pearson correlation of daily returns** across every open position's underlying
  over the last 30 sessions (a stock and an option on the same name collapse to one row).
  <span class="text-bear">Red</span> cells are pairs that move **together** — five "different"
  tickers that all trade as one become obvious at a glance, which the single
  "correlated exposure %" guardrail can only hint at as one number; <span class="text-bull">green</span>
  cells move **opposite** (a natural hedge); near-zero stays neutral. The strongest pair is
  called out above the grid, with a note when it's tight enough (|r| ≥ 0.7) to be effectively
  one bet. Names whose daily history can't be fetched are **excluded and listed**, never
  assumed uncorrelated, and a book larger than the per-request limit says which underlyings
  were **left out entirely** — never looked at, as opposed to looked at and failed.
  Correlation is backward-looking and drifts — not a prediction.
- **Closed losses** carry the same **wash sale?** flag the Journal shows, when the same
  symbol was re-entered within 30 days either side of the close. Informational only — not
  tax advice.

---

## Journal & analytics

Where you find out whether you actually have an edge. Populated by your **closed**
trades.

### Headline stats

- **Win rate**, **Expectancy** (mean realized P&L per closed trade =
  `winRate×avgWin − lossRate×avgLoss`), **Profit factor** (gross profit ÷ gross loss;
  > 1 = winners outweigh losers), total/realized P&L, average win/loss.
- **R-multiple analytics** — your results expressed in **R** (multiples of initial
  risk), the single best way to compare trades of different sizes. Requires a **stop**
  on each trade (so always log one). Includes the **expectancy in R**, the spread of
  outcomes, and a **System Quality Number (SQN)** — Van Tharp's measure of edge ×
  consistency (mean R ÷ std-dev of R × √N; ~2 is average, 3+ excellent).
- **Trades with no entry date** (see "Positions with no entry date" under
  [Data tools](#data-tools)) are counted in everything above — those need only a P&L — so
  `XW · YL` under the **Closed** tile always adds up to the count beside it.
  They're left out only of the figures that need a place in time: the equity curve,
  rolling expectancy, max drawdown, streaks, and the weekday/hold-time breakdowns, which
  say "N of M dated" where it matters.
- If a stats request **fails**, the page says so and offers a retry. It won't tell you
  your journal is empty because a request didn't come back, and a failed refresh keeps
  the last numbers on screen with a banner rather than blanking them.

### Breakdowns

- **By tag**, **by grade**, **by discipline** (checklist adherence), and **by timing**
  (which **weekday** you closed on, how long you **held**, and — for trades with a logged
  entry time — the **entry session**: open / late-AM / midday / power hour) — each with
  its own count, win rate, **profit factor** and **avg R** (2026-07-23), and realized P&L.
  Profit factor and avg R are what separate a genuine edge from a merely-frequent one — a
  low-win-rate setup with a big payoff can out-earn a high-win-rate one with a small payoff,
  which win rate and P&L alone can't show. Same null conventions as the headline stats: `∞`
  for a group with wins and no losses yet, `—` for a group where no trade logged a stop.
  This is how you discover *which setups and which behaviors* make you money.
- **What auto-trading now records at entry (2026-07-26).** Every trade the automated
  loop opens — paper and live, stocks and options — is stamped with its *at-entry
  context*: the screener's **raw 0–100 score** (not just the A/B/C grade), the
  **market regime** label that cycle (risk-on / neutral / risk-off; best-effort — blank
  if the read failed, never guessed), the **market ATR%** reading, and, for options,
  the **IV rank** the decision gated on. Live-placed positions also get a real
  **entry time** (ET), so from now on the bot's trades appear in the entry-session
  breakdown above — they previously carried no time at all and were silently absent
  from it. Live bracket exits record an **exit reason** (`stop` / `target` /
  `time_exit`) on the exit itself, so you can see *which exit mechanism* is making or
  losing the money instead of inferring it from prices. All of it is capture-only —
  nothing about entries, sizing, or exits changes — and it flows through the CSV/JSON
  export (new `entryTime`, `entryScore`, `marketRegime`, `marketAtrPct`, and
  `lastExitReason` columns) so a month of trades can be sliced by score band, regime,
  and session offline. Since 2026-08-22 live equity entries also stamp the day's
  **session VWAP at entry** (`entryVwap`, in the export too) — capture-only, like the
  rest: it exists so the journal itself can answer whether VWAP-aligned entries (longs
  above VWAP, shorts below) actually win more *here*, before any alignment filter is
  ever allowed to cost trade flow. Null when the intraday-bar fetch fails — never a
  guessed number.

### Wash-sale awareness

- Each row in the closed-trades table shows a **⚠ wash sale?** badge (2026-07-19) next
  to its Realized P&L when that trade closed at a **loss** and the same underlying
  symbol — stock or option — was also entered within **30 days** either side of when
  it closed (the IRS's 61-day wash-sale window: 30 days before, the day itself, 30
  days after). Hover the badge for the matching position's entry date. This is
  **informational only** — not tax advice, and this app never blocks or discourages a
  trade over it; confirm anything it flags against your 1099-B or a tax professional.
  It also doesn't try to match two *different* option contracts on the same underlying
  as "substantially identical" (genuinely gray-area even under IRS guidance) and only
  sees positions logged in this app — not other brokers or accounts.

### Auto-tune efficacy

- Only shown once **Auto-tune from realized edge** (Auto-Trade → Config) has made at
  least one risk-per-trade adjustment. For each past adjustment, shows the old/new
  **risk-per-trade %**, the Kelly suggestion and sample size behind it, and a
  **before/after** comparison — win rate and expectancy for autotrade's own closed
  trades entered before vs. on/after that adjustment's date (a manually-placed trade
  never counts here, since the risk-% change never touched its sizing). This is
  informational only: nothing here reverts a change automatically, however it looks —
  see `docs/STRATEGY_PLAYBOOK.md`'s sizing section for why that's a deliberate choice,
  not a missing feature. A very recent adjustment naturally shows few or zero "after"
  trades; that's the sample size telling you it's too soon to read anything into it.

### Curves & risk

Equity curve, edge over time, and drawdown & streaks are shown directly on the page.
**Risk of ruin**, **Excursions**, **Execution quality**, and **Stop overrun** are four
tabs of one **Analytics** button (top right) — pick a tab, the report loads on demand.

- **Equity curve** of cumulative realized P&L.
- **Edge over time** — a rolling 20-trade expectancy ($/trade). Rising means your edge
  is strengthening; drifting toward or below zero means it's decaying (shows once you
  have ~8+ closed trades).
- **Drawdown & streaks** — your **max** drawdown, your **current** drawdown (how far
  below your equity peak you are right now — "at peak" when you've just made a new high,
  red when you're at your worst point), and longest winning/losing streaks.
- **Risk of ruin** (Monte Carlo) — set a per-trade risk and a "ruin" drawdown
  threshold; it simulates thousands of trade sequences from your edge and reports the
  **% that hit ruin** plus a median ending. Your guardrail against over-betting.
- **Excursions (MAE/MFE)** — for closed *stock* trades, replays candles over the holding
  period to show **Maximum Adverse Excursion** (how far underwater it went) and **Maximum
  Favorable Excursion** (how far in profit), in **%** and **R**. Use it to tighten stops
  and set realistic targets. A trade opened and closed in the **same session** is measured
  on 5-minute bars narrowed to the minutes you actually held; trades held longer use daily
  bars. Intraday history is short, so an older same-session trade may fall back to daily —
  the panel reports the split ("3 measured on intraday bars, 47 on daily"), because a
  daily-bar row for a same-session trade credits the trade with that whole day's high and
  low, including hours you were flat. Read those rows as an upper bound. Because it
  fetches candles per trade it caps how many it does per request, and it can't measure a
  trade with no entry date or one the provider has no candles for — so it also **says what
  it left out** ("averages over 12 of 70 closed stock trades…") rather than presenting a
  partial sample as the whole picture. If nothing at all could be measured it tells you
  why, instead of claiming you have no closed stock trades.
- **Execution quality (slippage)** — for each **live-traded** entry/exit that came from an
  order with a limit price, compares the actual **broker fill** to the **limit you set**.
  Positive $ always means it cost you money, whichever side you were on (a buy filled
  above your limit, or a sell filled below it); sorted worst-first. Only live fills placed
  through the app's Trade builder count — a pure stop-market fill has no limit to compare
  against, and a manually logged or imported trade was never a live order at all, so
  neither is included. A consistent positive bias points at marketable limits or wide
  spreads at entry/exit.
- **Stop overrun** (2026-07-28) — for every *stock* exit that was a **stop execution**,
  compares the realized exit price to the position's **declared stop**. Positive overrun
  means the exit landed **beyond** the stop (a gap-through or a wide spread), costing
  more than the planned 1R — reported in **$**, **%**, and as **extra R** per stop, with
  a breakdown by **entry price band** (<$5, $5–15, $15–50, ≥$50), where the cheap-ticker
  cost concentrates. An exit counts when its recorded exit reason is `stop` (stamped
  automatically for auto-traded positions since 2026-07-26), or — for older rows without
  a reason — when it landed at/beyond the declared stop, flagged as *inferred* so the
  report says how much of itself rests on inference. An exit with a *different* recorded
  reason never counts, even below the stop: a deliberate sale isn't a stop execution.
  Unlike Execution quality above, manual, imported, and paper-era trades all count —
  the comparison is against your own declared stop, not a broker order.

### Benchmark

- **You vs SPY (buy & hold)** — your realized return over the trading window vs simply
  holding the index, and your **alpha**. Alpha < 0 means buy-and-hold would have beaten
  your active trading over that period — a humbling, essential reality check. The
  benchmark symbol is configurable in **Settings**.

### Data tools

- **Export** CSV or JSON, take a full **`.db` backup**, or **import** a positions
  export (append or replace). Great for backups and moving between machines. A restore
  brings back **everything** the export wrote, including each lot's **Webull account** and
  **entry time** — before 2026-07-26 the import quietly dropped both, so restoring a backup
  (or pressing **Undo** on a delete, which round-trips through the same route) handed every
  position back unassigned and without its time-of-day data. Import also enforces the same
  rules the log-trade form does — ISO dates, a positive quantity and entry price — so a bad
  file is refused with the offending row named rather than silently landing in your
  journal.
- **Check the journal for bad rows** — `npm run check:journal` audits every position
  and exit for defects the app can't show you on screen: a date that isn't `YYYY-MM-DD`,
  an exit dated before its own entry or in the future, an **option whose entry date is
  after its own expiration** (impossible — usually the Webull import stamping the date
  it ran, because the broker's payload carried no open date), exits that close more than
  the position ever held (the row just reads as *closed*), a status that contradicts the
  remaining quantity, a zero entry price, or a broker-tracked lot with no account
  recorded. An option's **expiration** being in the future is not a defect — that's what
  an open contract is — so it's exempt from the future-date check. It also lists, as
  **informational**, any imported position with **no entry date** (see below) — not a
  fault, just something you can fill in. A run whose only findings are informational
  still reports your journal as having nothing to fix; it lists those rows anyway, so
  you can act on them or leave them.
- **Positions with no entry date.** Webull's positions feed reports your *current
  holdings* — quantity and an average cost — so a lot you built from several buys has no
  single open date for it to give, and often it gives none at all. Rather than invent one
  (which used to quietly feed your hold-time stats, wash-sale window and equity curve),
  the app now records **no date**. Those trades still count in **win rate, expectancy and
  profit factor** — those need only P&L — but they sit out of the **equity curve**,
  **rolling expectancy** and the **timing breakdowns**, which say inline how many trades
  they're based on (e.g. *47 of 54 dated*). Fill the date in from memory via **journal**
  on the position and it rejoins them. Logging a trade by hand still requires a date. It also finds rows that a background job dated a day late, back when the
  Webull sync and the order reconciler used the server's UTC clock instead of market
  (ET) time — those land in the wrong day's stats and add a phantom day of hold time.
  **It reports and stops** — there is no apply mode, deliberately, because several of
  these have more than one sensible fix and guessing at your real trading record is
  worse than naming the row. Fix what it finds with **journal** / **exit** / **del** on
  the Positions page and re-run. Every check is listed whether it fired or not, so
  "clean" always tells you what it was clean against.
- **Import CSV** — bring trades in from a spreadsheet journal or a broker export.
  One row = one trade. Headers are matched loosely (case-insensitive, common
  aliases), `$` and thousands-commas are tolerated, and each row is validated on
  its own so one bad row doesn't sink the import.
  - **Required:** `symbol`, `quantity`, `entryPrice` (aliases: price/avg price/cost),
    `entryDate` (aliases: date/opened).
  - **Optional:** `side` (buy→long, sell→short), `fees`, `assetType`/`type`,
    `optionType`, `strike`, `expiration`, `exitPrice` + `exitDate` (attaches a
    closing exit), `tags` (split on `;`/`|`), `grade`, `notes`, `stop`, `target`.

---

## Alerts

Get notified when the market — or one of your positions — needs a decision.

### Stock alerts

Create an alert on a **symbol** with a **metric** and **operator**:

- **Metric (`kind`)**: `price`, `change %`, `rel. volume` (a volume-spike trigger),
  `RSI`, **MA20−MA50 spread** (a level-based MA-cross proxy — `above 0` = the short
  average is above the long), or **% from the 52-week high / low** (e.g. `above -2` on
  *% from 52w high* fires within 2% of a new high).
- **Operator**: `above` / `below`, with a **threshold** and optional note.
- Click **Refresh** (or rely on background polling) to evaluate against current data.
  Newly-triggered alerts raise a toast anywhere in the app.

### Option-contract alerts (entry & exit)

Toggle the **New alert** form to **Option** to watch a specific contract (underlying +
**call/put** + **strike** + **expiration**) with a **role** and a **trade plan**:

- **Role** — **Entry signal** (you're watching for a good entry on a contract you
  don't hold yet) or **Exit signal** (on a contract you do hold).
- **Trigger metric** — the **underlying price**, or the contract's **mark**,
  **bid**, **ask**, **|Δ|** (absolute delta), or **IV %** — `above` / `below` a
  threshold. (Mark / bid-ask / |Δ| / IV need an options-capable provider; an
  underlying-price trigger works with any provider.)
- **Trade plan** — write your own **entry** and **exit** plan. For an **entry** alert
  the app also **auto-attaches a suggested exit** from your exit rules (take-profit /
  stop-loss / time-exit), so a signal always arrives with a pre-decided exit. When the
  alert fires, that exit suggestion rides along in the message. Expand the row (chevron)
  to read the full plan.
- **One-click from the Entry-scan** — on **Options → Entry scan**, every ranked
  contract has a **＋ Alert** button that opens this form pre-filled with the contract,
  a sensible breakout trigger, and a strategy note summarizing the scan (delta / IV /
  DTE / rank). Adjust and save.

Option alerts are **rule-based heuristics you configure — not buy signals.**

### Position exit alerts (automatic)

For your **open positions**, the app watches for:

- **stop-hit** / **target-hit** — price crossed your planned stop or target.
- Option exit rules — **take-profit**, **stop-loss**, **time-exit** (near expiry),
  **delta-drift**.

These surface in the 🔔 bell, on the **Today** dashboard's *Needs attention* panel, and
as toasts.

### Auto-checking

Background polling is **off by default** (to respect provider rate limits). Turn it on
(every 30s / 1m / 5m) from the bell or **Settings**. This runs **in your browser**, so the
tab has to stay open.

**Desktop notifications (optional):** enable them in **Settings → Alerts** (the browser
will ask permission). When an alert fires while this tab is in the **background**, you
get a desktop notification — when the tab is focused the in-app toast already covers it.

### Server-side watching (alerts with the app closed)

The browser-based checks above stop when you close the tab. To keep watching **with no
browser open**, turn on the **server-side poller** in **Settings → Server-side watching**:
the server evaluates your alerts on a schedule (30s / 1m / 5m / 15m) and **POSTs anything
that fires to your webhooks**.

- Configure the destinations **server-side** (they're secrets), in `server/.env` — set any
  or all; a fired alert **fans out to all of them at once**:
  - `SLACK_WEBHOOK_URL` — a Slack Incoming Webhook.
  - `DISCORD_WEBHOOK_URL` — a Discord channel webhook.
  - `ALERT_WEBHOOK_URL` (+ `ALERT_WEBHOOK_FORMAT`) — a generic webhook, e.g. phone push via
    an [ntfy](https://ntfy.sh) topic, Zapier, or your own endpoint.
- The status line in Settings shows which destinations are wired up; **Send test
  notification** posts to each and reports per-channel success/failure.
- The **server process must stay running** for this to work (leave `npm run dev`/the
  server up, or run it as a service / in Docker). It's independent of any open tab.

---

## Auto-Trade

The **Auto** tab is the working area for the automated-trading initiative described in
**[docs/AUTOTRADING_SPEC.md](../docs/AUTOTRADING_SPEC.md)** — a fully autonomous
screen → decide → risk-check → execute → journal loop, distinct from the human-confirmed
live trading on the **Trade** page (which always requires you to type a confirmation
phrase before *every* order). **Paper trading** and **Live trading** below are
independent: paper is always a local simulation that never reaches a real broker, and
runs whether or not live trading is on. Live trading, once explicitly enabled, places
real orders through Webull with **no per-order confirmation** — only a one-time typed
phrase to turn it on, plus the guardrails and kill switches described below.

The page opens on two tabs (2026-07-17), so settings you change occasionally and live
state you watch constantly aren't one long scroll together. **Configuration** holds
everything below through **Macro event blackout list** — settings you set once and
revisit occasionally, further grouped into labeled cards (core settings; sizing & risk
guardrails; screening & entry filters; equity exits; options exits; entry timing;
auto-promote) so the field count stays scannable. The kill switch stays visible on
both tabs, since a halt you need in a hurry shouldn't be a tab-switch away.

At the bottom of the Configuration tab, **All settings (read-only)** lists every field
the server is actually running, straight from the config API, with a filter box. It is
there because the editable cards above are hand-built one control at a time, and for a
while 28 settings had no control at all — not greyed out, simply absent from the app,
including live-exit behaviour that was switched on and shaping real trades. This panel
renders whatever the server sends, so a setting can never go missing from the screen
again even if nobody adds an editor for it. Editing still happens in the cards above;
anything without an editor can only be changed through the API for now.

**Dashboard** holds everything that reflects live, ongoing state, grouped into three
labelled sections so the page reads top-to-bottom as one story instead of as six
equally-weighted cards in the order they happened to be built:

- **Now** — what the loop is holding and how the day is going. **Monitoring** comes
  first, because it is the summary that orients you: the Books table, the account-wide
  figures, portfolio Greeks. Then **Live positions** (real money) and **Paper trading**
  (simulated), which sit next to each other so the two books can be compared without
  scrolling past anything else. Each card carries its nature in its own title — "Live
  positions · real money, no per-order confirmation", "Paper trading · simulated, never
  reaches a broker" — so a collapsed card still tells you which one it is, and each is
  split into an **Equity** and an **Options** half with the same one-line
  open/closed/realized/unrealized ledger above each table.
- **History** — **Recent activity**, the journal of what the loop actually did, most
  recent first. Live **options** refusals appear here too (2026-09-02): a blocked risk
  check logs **options risk blocked** naming the rule that failed and the premium and
  contract count it sized, and a refusal after that point — a stale quote, a probation
  cut that rounds the size to zero — logs **options entry refused** with the reason.
  Both are written **once per symbol per day**: they describe steady conditions, not
  moments, and the options decision can emit well over a hundred signals in a single
  minute-long cycle. Before this, a live options book that never traded looked exactly
  like a quiet one.
- **Tools** — **Research, Screen & Decide** and **Backtest & walk-forward**. Both are
  run on demand and neither places an order, so both ship **collapsed**: they produce a
  screenful of output each, and the dashboard is meant to open on state rather than on
  tooling. Expand either one and it stays expanded — every card on this page remembers
  whether you left it open.

- **Configuration** — a master **enabled** switch for the execution loop below (when on,
  the server runs the full cycle on its own every minute, placing paper trades — see
  "Paper trading" below), the active **risk profile** (`Moderate`, the conservative
  default, or `Aggressive`) — today this is just a label, journaled with every trade so
  your history shows which posture you intended; it no longer changes any guardrail
  number itself (see below — every one is its own directly-editable field now).
  Switching to Aggressive still always pops a confirmation dialog, since flipping the
  label that's baked into your trade journal should be a deliberate choice, not a
  default, never a silent dropdown change. Next to it, the **options strategy** the
  loop builds (`Single leg` — a long call/put, uncapped upside, the default; `Debit
  spread` — the same long leg plus a further out-of-the-money short leg that caps both
  max loss and max gain; or `Auto (by IV rank)` — picks per candidate from that
  candidate's own IV rank at signal time: debit spread once IV rank reaches **50**
  (rich premium — cap the cost), single leg below that (cheap premium — keep the
  uncapped upside), same live/paper/backtest engines either way; switch anytime, no
  confirmation needed), and
  **account equity ($)** — what the risk engine sizes trades and computes its % caps
  against. Type it in manually, or click **Sync from Webull** to pull your live
  account's net liquidation value instead (needs a Webull account ID set under **Live
  trading** below first — the sync itself doesn't require live trading to be enabled).
  Until equity is set one way or the other, the risk engine blocks every trade (fails
  closed rather than guessing). Once a Webull account ID is set, equity also **syncs
  automatically** — the background execution loop (see "Configuration" above) re-pulls
  it every cycle regardless, so it self-heals even with the page closed; the tile's own
  display piggybacks on this page's own **Auto** refresh (below), throttled to at most
  once a minute even if you've picked a faster cadence, and skipping a refresh whenever
  the field has an unsaved manual edit so it never clobbers
  in-progress typing.
- **Tune from target daily gain** (2026-07-23, collapsed by default, right below Core
  settings) — instead of hand-setting the ~30 risk fields below one at a time, set a
  **target daily gain %** and let it derive the whole risk config from that plus your
  account equity. A **sizing basis** toggle decides how the target maps to per-trade
  risk: **Expected day** sizes so the target is your _average_ outcome (assumes ~45% win
  rate — more risk per trade), **Perfect day** sizes so it's your _best-case ceiling_
  (every trade wins — less risk per trade). Higher targets loosen everything, not just
  position size: the tool picks an aggressiveness band (conservative / moderate /
  aggressive) from the target and sets exposure caps, screening filters (relative
  volume, share price, average volume, and the conviction-score floor), options
  delta/DTE/IV selection (including the IV/RV cheapness gate), and the equity-scaled
  dollar caps to match. It shows a full
  **preview — every changed field, current → tuned — plus warnings** (e.g. when the
  target would need a dangerous per-trade risk, or when either auto-tuner is on and will
  later move what the tune set — the risk %, or the R multiple the risk % was solved
  from); **nothing changes until you click Apply**, and every field
  stays editable afterward. The target % and sizing basis you pick are remembered in your
  browser, so the card returns to your last choice after a reload or a view switch (they
  drive the preview; they aren't themselves a saved setting — Apply writes the derived
  risk config, not the target). A **Reset to moderate** button restores the standard moderate
  baseline, equity-scaled for your account. It deliberately **never touches your
  live-enable switch, kill switch, account ID, probation ramps, or movers discovery** —
  only the risk/aggressiveness settings, screening filters, options selection, and the
  dollar caps. Deliberately lets you push the target
  high (it's your call), but higher targets mean bigger swings both ways — decision
  support, never a promise of the gain. Needs account equity set first. Since
  2026-08-21, applying a tune also **stores the target as a live daily goal**: each ET
  day the loop snapshots the account's starting value, and once synced equity reaches
  `dayStart × (1 + target%)` it **banks the day** — one `daily_target_reached` entry in
  Recent activity, new live entries and scale-ins halted until the next trading day
  (sticky even if equity slips back), while exits, reconcile, the broker sync, and
  paper all keep running. The Monitoring card shows the goal line and progress. It
  never sizes UP to chase a shortfall — behind the target, sizing stays exactly what
  the tune calibrated. **Reset to moderate** (or clearing the field) disarms it.
  Since 2026-08-27 a **deposit or withdrawal no longer counts as gain**: the goal is a
  _return_ on the day's starting value, and money you pay in was not earned. When the
  broker reports a sustained balance change that its own day P&L does not account for,
  the loop moves the day's baseline by that amount instead — one
  `daily_baseline_rebased` entry in Recent activity — so the gain % runs continuously
  across the flow and a deposit can neither bank the day nor distort the %-of-equity
  caps derived from it. It takes **two** agreeing signals to declare a flow, so a
  genuinely large trading gain is never mistaken for one and re-based away. A reach you
  had already earned before the flow landed stays banked.
  Since 2026-08-22 a **give-back guard** protects the day that _almost_ banks: applying
  a tune also stamps an **arm** level at 2/3 of the target and a **floor** at 1/3
  (`giveBackArmPct` / `giveBackFloorPct` — a 3% goal arms at +2%, floors at +1%). Once
  the day's gain has touched the arm level the guard arms (the Monitoring card shows
  "guard armed"); if the gain then falls back to the floor, new live entries and
  scale-ins halt for the rest of the day exactly like a banked day — one
  `daily_give_back_halted` entry in Recent activity, sticky until the next ET day,
  everything else unaffected — so a green morning can't be traded all the way back to
  flat. Chop that never reaches the arm level never triggers it, and the guard runs
  only while both levels are set with arm above floor (≥ 0). Two optional companions
  (2026-08-22, both off by default, live-only) reduce the chance of the fade in the
  first place: **finish-line sizing** trims the closing trade's risk to just what
  banks the day once the remaining gap is smaller than a full-size winner's expected
  payoff (floored at quarter size, never sizes up — visible as the
  `finish_line_sizing` risk-check line). "Full-size" there means the size **this
  entry will actually take**, after the step-down, the regime cut and the edge
  multipliers have had their say — not the raw risk-per-trade %. It has to: the trim
  is itself one of those multipliers, so measuring against the raw % double-counted
  every cut already in force and trimmed a trade that could no longer overshoot
  anyway (fixed 2026-09-05). An **armed-day min signal score** holds
  new live entries to a higher conviction bar while the guard is armed (0 = off).
  Beside it, a **live conviction floor** (`liveMinSignalScore`, 2026-09-06, 0 = off)
  applies the same idea on an ordinary day: a new **live equity** entry must clear
  it, whatever the tape is doing. It is a separate setting from the screening
  minimum on purpose — that one gates signal generation for **both** books, so
  raising it would starve the paper track the strategy is measured against. Paper
  keeps taking every signal; live takes only what clears the floor, which keeps the
  comparison honest. The two bars compose, and whichever is stricter at that moment
  decides; a refusal is journaled as `live_score_floor_skipped` or
  `finish_line_skipped` depending on which one bit.
  Separately, a **symbol loss cooldown** (also 2026-08-22, off by default) gives the
  loop a memory of losing on a name: once a symbol takes the configured number of
  losing live trades (2+) within a rolling window of calendar days, its new live
  entries — stock and options alike — are skipped for the cooldown period after the
  last loss. **The cooldown is counted in trading SESSIONS** (fixed 2026-09-06): it used
  to count calendar days, which meant a weekend spent the cooldown while no session
  passed — the same 3-day rule skipped 3 sessions after a Monday loss and *none* after a
  Friday loss into a holiday Monday. Two names were cooled for exactly nothing that way.
  A weekend or a market holiday now costs the cooldown nothing. It is journaled once per day (`symbol_cooldown_skipped`) and listed on the
  Monitoring card; paper keeps trading the name as the evidence track, and exits are
  never touched. Applying a tune
  also **arms automatic re-anchoring of the four dollar caps** (max order $ and max
  daily loss $, equity and options): equity syncs from the broker every minute, and once
  it has drifted **15%+** from the equity the tune derived those caps at, the loop
  re-derives them with the same formulas and journals a `live_caps_reanchored` entry to
  Recent activity — so a shrinking account's daily-loss cap tightens with it instead of
  quietly becoming a bigger share of what's left. Caps you've since edited by hand are
  never touched (the event names any it skipped). Full walkthrough,
  including the exact formula, the band table, and the re-anchoring rules:
  [Tune from target daily gain](TUNE_FROM_TARGET.md).
  Every guardrail the risk engine actually enforces is its own directly-editable field
  below account equity, independent of the risk-profile label above — switching
  Moderate ↔ Aggressive never silently changes any of them, matching how **max
  concurrent positions** (ONE combined open-position budget shared by stocks and
  options — a stock position and an option position draw from the same pool) already
  worked: **risk per trade** (% of equity risked per trade, before any step-down cut;
  for options this is premium paid, not notional exposure), **max daily drawdown** (%
  realized loss for the day that halts new entries until tomorrow — existing
  positions' stops/targets keep working regardless), **step-down after (consecutive
  losses)** and **step-down size cut** (once your losing streak reaches the trigger
  count, new positions size down by the cut %, until a win breaks the streak), **max
  aggregate open risk** (a PRE-TRADE % cap on total open risk — size × stop distance —
  across every open position plus the one being proposed, distinct from the daily
  drawdown halt, which only reacts to realized losses after a trade closes), **max
  correlated exposure** (% of equity cap on capital, not risk, already concentrated in
  tickers statistically correlated with a candidate — by default |r| ≥ 0.7 over 30
  trading days, both now their own **correlation lookback (days)** and **correlation
  threshold (|r|)** fields right below it), **correlation-aware selection**
  (2026-07-24, off by default — the opt-in toggle right under the correlation
  threshold: before the caps above bind, it re-ranks the score-sorted candidates so
  that among names correlated at ≥ that threshold, the higher-scored one keeps its
  rank and the redundant lower one is demoted to the back of the list, so diverse
  picks — not a correlated huddle — win the position and trade caps; it only
  reorders, never drops anyone, and the correlated-exposure cap above stays the
  backstop; applies to live, paper, and backtests), **max sector exposure** (a cheaper backstop
  to the correlation cap right above it — % of equity cap on capital already
  concentrated in the candidate's own universe sector, regardless of price correlation;
  two names in the same sector can carry low correlation today and still share the same
  macro risk), **max trades per day** (a hard cap on
  new entries, paper and live, stocks and options, all combined), and **regime ATR
  threshold** with **regime size cut** (a softer, graduated companion to **max market
  ATR** below: once the broad-market proxy's own ATR% crosses this LOWER threshold,
  new positions size down by the cut % instead of being blocked outright — max market
  ATR still blocks everything once volatility gets more extreme; mirrors step-down
  sizing above, just keyed to market volatility instead of a losing streak, and stacks
  with it if both are active at once. Regime size cut defaults to 0% — disabled, so
  leaving it untouched changes nothing regardless of the threshold's own value; setting
  the **threshold** itself to 0 likewise disables the cut entirely. **Live
  and paper only — no backtest equivalent**, same as max market ATR itself; watch
  **Recent activity**'s risk-check entries to see it fire). Finally, **equity-curve
  de-risking** (2026-07-24, off by default) is the same idea keyed to your _own_
  results instead of the market: when the strategy's cumulative closed-P&L curve —
  tracked separately for paper and live — is below its **equity-curve lookback
  (days)**-day moving average, new positions size down by the **equity-curve size cut
  (%)**, restoring full size once the curve climbs back above its average. A softer,
  graduated companion to the binary **max daily drawdown** halt above; it stacks
  multiplicatively with step-down and regime sizing, and (like them) is live + paper
  only with no backtest equivalent. Separately, **max ADV participation (%)**
  (2026-07-24, 0 = off by default) caps a single equity position at that % of the
  name's ~20-day **average daily volume**, so the risk engine never builds a position
  bigger than you could exit cleanly — a liquidity backstop the risk-based sizing
  doesn't otherwise enforce (options already gate on their own open-interest/volume
  floors, so this is equity-only). When a name's average volume can't be resolved the
  cap is skipped, not blocked. Finally, **conviction grade A ≥ score** and **B ≥ score**
  (2026-07-24) stamp every autotrade entry with a grade from its screener total score —
  **A** at or above the A threshold, **B** at or above the B threshold, else **C**. This is
  always on (it doesn't change what trades, only labels them): the grade flows into the
  Journal's per-grade edge report so you can see whether your high-conviction picks actually
  outperform, and it's the key the next field sizes by. That next field —
  **expectancy-weighted sizing** (2026-07-24, off by default) — closes the loop: instead of
  every grade risking the same base %, each grade is sized by its _own_ realized edge. A
  grade whose closed trades average a positive R is sized up, one that bleeds is sized down,
  and breakeven stays flat (multiplier = 1 + average R, clamped to the **expectancy multiplier
  bounds (min / max)** you set, e.g. 0.5×–1.5×). A grade with fewer than the **expectancy min
  sample (trades/grade)** closed trades stays neutral at 1×, so a thin sample never moves
  anything. Each book tunes itself from its own history (paper and live are scored separately),
  the multiplier recomputes every tick from realized results, and it stacks multiplicatively
  with step-down, regime, and equity-curve sizing — the aggregate-risk cap still binds on top.
  Live + paper only, no backtest equivalent (same as the other sizing multipliers).
  **Equity only:** options entries are stamped with a grade and appear in the per-grade
  edge report, but grade expectancy does not size them. That is a standing decision
  rather than an oversight — an option's R is the premium paid, while its grade comes
  from the *underlying's* screener score, so the two are further apart than they are for
  a stock — and it would be inert today regardless, since neither options book is near
  the min-sample floor. The per-method lean below is the one that does reach options.
  **Method-weighted sizing** (2026-08-21, off by default) is the same realized-edge lean
  sliced along a different axis: instead of conviction grades, it scores the four
  **methods** — long stock, short stock, calls, puts — each on its **most recent** closed
  trades (a rolling window, so an old config era can't outvote the current one), and
  applies the identical formula (1 + average R, same expectancy clamps and min-sample
  floor). It **leans, never switches**: every method keeps trading — an unproven one at
  1×, a bleeding one sized down toward the min clamp, an earning one sized up — so
  sizing drifts toward whatever is currently working toward the daily-gain goal while
  every method keeps generating the evidence that could change its standing. It never
  presses: multipliers come from realized results, never from distance to the target.
  One deliberate difference from grade expectancy: the method lean is scored from a
  **single shared record** — the live journal's closed auto-trade positions plus the live
  options book — and the same multipliers are then applied to every book, paper included.
  "Which instrument and direction is earning" is one question about the market, not a
  per-book one, and the paper books are too thin to answer it separately. (Grade
  expectancy is the opposite: each book is scored only on its own history, so a paper hot
  streak can never size up real money.)
  The Monitoring card's **Method performance** table shows each method's recent record
  and the multiplier currently in force (visible even with the lean off, so you can see
  the evidence before acting on it). Every field here
  applies to paper and live trading alike, and each has its own **Save** button, so
  you can change one without touching the rest. For a plain-English walkthrough of each of these — with worked
  examples and guidance on what to change when nothing's trading — see
  **[Auto-Trade Risk Settings](./AUTOTRADE_RISK_SETTINGS.md)**. A second group of fields
  governs the automated loop's own **screening and decision thresholds** — a
  structurally different category from the risk-sizing fields above (these gate what
  counts as a candidate and how it's priced, not how an approved signal is sized or
  capped): **trade direction** (`Long`, `Short`, or `Both` — in `Both`, every
  candidate is scored as long AND short from the same indicators and the loop trades
  whichever side actually qualifies for *that* symbol, so a single cycle can open some
  positions long and others short; it's never one exclusive mode applied to the whole
  batch. A live **short** position carries theoretically unlimited downside, unlike
  this app's long stock and long-option positions, so it stays gated by the existing
  **Allow naked short** guardrail under Live trading, below — with Short or Both
  selected but that box unchecked, the loop still screens, decides, and paper-trades
  the short side normally, it just can't send a live short order to the broker. Options
  entries are unaffected either way — an autotrade options position is always long the
  contract, a put for a bearish read instead of a call, which is already defined-risk),
  **min relative volume** (a candidate's volume must be at least this many
  times its own average to pass the screener — note this compares today's volume
  *so far* against an average FULL day, so it climbs through the session: a
  value that blocks everything at 10am can let everything through at 3pm.
  Prefer **min relative-volume pace** below unless you specifically want an
  absolute unusual-volume floor), **min relative-volume pace** (2026-08-25 — the
  same idea made time-of-day neutral: a multiple of the *median* relative volume
  across everything the screener scored this tick. The median stock is trading
  at a typical pace by definition, so "1.5×" means the same thing at 10am and
  3pm, and a market-wide quiet or busy day cancels out instead of silently
  moving the bar. 0 = off. Measured on the live book at 10:47 ET the median
  symbol read 0.10 and exactly one of 261 reached 1.0 — which is why a fixed 1.0
  floor had been finding 3 candidates in 33 minutes. Journaled as
  `excluded_rel_vol_pace` with the pace, the floor and the median it was divided
  by, so any figure can be checked rather than taken on faith; when too few
  symbols are scored to estimate a median it fails **open**),
  **min move today (%)** (2026-08-25 — a candidate must have moved at least this far
  in the trade's own direction *today*: a long needs +this, a short −this. 0 = off. The
  rest of the screener is largely positional — momentum averages today's change with the
  distance from both moving averages, and *trend* scores that same MA relationship again —
  so a stock can be **falling today** and still score as strong momentum off an earlier
  run. That is not theoretical: one was bought long while down 3.45%, and on the same day
  17 of the 50 symbols clearing the score bar were down on the day),
  **momentum: today's move only** (2026-08-25 — scores the momentum component from
  today's change alone, leaving price-vs-MA to the *trend* component that already measures
  it. Removes the double-count above; intended for an intraday loop, where where a stock
  sits relative to last month's average is not the question),
  **min share price ($)** and **min avg volume (shares)** (2026-07-27 — the liquidity floors, previously stuck at the
  engine's hardcoded $1 / 200,000. Sub-$3 movers carry a bid-ask/slippage tax the
  zero-cost backtester can't show — measured on the live book, roughly a fifth of all
  bot losses landed *beyond* the declared stop, concentrated in exactly those names.
  Raising the price floor is the single most direct way to stop paying that tax; 0
  disables either floor), **discover Webull premarket movers** (2026-07-27 — on by
  default, matching the old always-on behavior. Off = the loop screens only your
  curated universe, without unplugging Webull (which live trading still needs);
  movers auto-promotion naturally goes quiet too, since it only ever considers
  movers-sourced candidates), **min signal score** (2026-07-26 — the
  conviction gate: a candidate's **weighted total screener score** must reach this
  0-100 floor to pass screening at all. Before this existed, the score only sorted
  candidates and stamped the A/B/C grade — a symbol scoring 3 that cleared the raw
  filters could trade at full size on a thin day exactly like one scoring 90. 0
  disables (the default, so an untouched config changes nothing); the B-grade
  threshold — 60 by default — is a natural starting point. Applies to equity and
  options candidates alike (options decide from the same screened set), to the manual
  Screen/Decision preview, and — because it counts as failing screening — a mover that
  scores below it also stops accruing movers-auto-promotion days. A backtest can apply
  the same gate via its screener-config override, so you can measure a floor before
  turning it on live), **require weekly trend alignment** (a
  second, longer-horizon confirmation on top of the daily setup: price must ALSO be on
  the right side of its own WEEKLY moving average — unlike the plain "require trend
  alignment" screener filter, this one is wired into the unattended loop itself, so
  toggling it actually changes what the loop trades, not just what a manual preview
  shows; off by default, and live, paper, and backtest all honor it — watch **Recent
  activity** to see it fire), **relative strength weight** (2026-07-17 — how much a
  candidate's own out/under-performance vs. a benchmark counts toward its total
  screener score, on the same 0-100 scale as every other scoring component — see
  **About**'s scoring table for the full breakdown), **benchmark symbol** (what
  relative strength measures against, e.g. `SPY` — only matters once the weight above
  is nonzero, at which point the loop fetches that symbol's own daily candles once per
  cycle, not once per candidate), and **relative strength lookback (days)** (trading
  days back for both the candidate's own and the benchmark's return that comparison
  uses), **sentiment weight** (2026-07-18 — how much a simple, transparent keyword
  count over each candidate's recent headlines counts toward its total screener score,
  on the same 0-100 scale as every other component and off by default — see
  **About**'s scoring table for the word list and full breakdown), **regime-adaptive
  scoring weights** (2026-07-24, off by default — a toggle plus three editable weight
  presets, one per **market regime**: risk-on / neutral / risk-off. When on, the loop
  reads the regime gauge at scoring time and weights candidates by the matching preset
  instead of the fixed defaults, so the strategy can reward trend more when risk is on
  and RSI/mean-reversion more when it's off. Each preset governs only the six core
  weights — relative strength and sentiment keep their own weights above — and all three
  default to the standard weights, so enabling changes nothing until you edit a preset.
  Live, paper, **and backtests** — a backtest run derives each historical day's regime
  from the benchmark (SPY) series it already loads, so you can measure a differentiated
  preset before enabling it live. (The backtest regime is a documented simplification of
  the live gauge: it uses the proxy's trend and volatility only — breadth is omitted, since
  a backtest doesn't rescan the universe each day — and the 200-day trend reads as
  "unknown" until 200 bars of proxy history exist.)), **max ticker ATR**
  and **max market
  ATR** (skip a candidate whose own volatility is too high, or skip every new entry
  this cycle if SPY's own volatility is too high — stricter than the manual Screen/
  Decision preview below, since an unattended loop has no one to override a bad read),
  **stop distance** and **target** (the stop sits this many ATRs from entry; the target
  sits stop-distance × this further out, as a reward:risk multiple), **max stop distance
  (%)** (2026-08-25 — a hard ceiling on how far the stop may sit from entry, as a % of
  entry price; 0 = off. The ATR here is the **daily** range, so a 1.5× stop is one and a
  half typical *days* away — right for a swing, wrong for a loop that scratches at 90
  minutes and is flat by the close. Because position size is *risk budget ÷ stop
  distance*, an over-wide stop spends the whole budget on a share or two, and because the
  target is a multiple of that same distance, it lands somewhere the session will never
  reach — so trades exit on the stagnation timer near break-even instead. Capping the
  stop shrinks risk-per-share, so the *same* dollar risk buys a real position, and it
  fixes the target for free. Measured on this book: a 14.6% stop meant 1 share and a
  +14.4% target; the stock traded −1.15%/+3.42% after entry, where a 2% stop survives, a
  3% target is hit, and the identical risk buys 14 shares. It is a **ceiling, never a
  floor** — a calmer stock keeps its own tighter ATR stop — and the signal's rationale
  says when the cap bit), **session buffer** (no new entries within this many minutes of the open or close, when prices
  are most distorted), **earnings blackout** (skip an equity candidate whose next
  known earnings date falls within this many calendar days — an unattended loop can't
  react to an earnings-driven overnight gap the way ATR-based stop sizing assumes;
  options entries are unaffected, since an approaching print already shows up as
  elevated IV rank there instead), and **macro event blackout (hours)** (2026-07-18 —
  hard-block ALL new entries, every symbol, within this many hours either side of any
  date-time on the **macro event blackout list** below it — unlike earnings blackout,
  this is market-wide and checked once per cycle, the same gating point as session
  buffer, not a per-candidate screener check. There's no economic-calendar data feed
  in this app, so that list is entirely hand-maintained: add your own FOMC/CPI/jobs-
  report dates from the Fed's/BLS's own published calendars; nothing is pre-seeded, and
  the blackout stays off regardless of the hours value until at least one date is on
  the list). All seventeen default to the values the loop always used before they were
  configurable (trade direction to `Long`; earnings blackout's own "before" is simply
  never checking — 0 disables it; min share price $1 and min avg volume 200,000 — the
  old engine constants; movers discovery on; min signal score 0 — no conviction gate;
  relative strength weight 0, benchmark `SPY`, lookback 20 days; sentiment weight 0;
  macro event blackout 0 hours with an empty list), so
  leaving them untouched changes nothing; the manual
  Screen/Decision preview
  below defaults to these same saved values too (so it previews what the loop would
  actually do), though it has no UI to override them ad hoc today. A related but
  separate **max hold time (days)** setting forces a position closed at the day's price
  after it's been open this many calendar days without its stop or target firing — a
  backstop against a position that's just drifting sideways forever. Defaults to
  **0 (disabled)**, so leaving it untouched changes nothing; unlike the eight fields
  above, it has no manual-preview equivalent — there's nothing to preview about how
  long a position stays open before it's even entered. Because that close has to clear
  the position's resting stop/target first, it **refuses to run** whenever it can't
  positively account for them — the broker's open-order list came back unreadable, an
  order on the symbol couldn't be identified, or the race check couldn't be run. The
  position keeps its stop and the close is retried next cycle (and journaled, so it
  reaches the [unresolved-order alert](#auto-trade)). This is deliberately the safe
  direction: a close placed alongside a stop that's still working can fill twice,
  which for a long leaves you **short**. Its intraday sibling is the **stagnation
  exit** (2026-08-22, live equity only, default off): a position that has made less
  than the configured **R progress** after the configured **minutes** — counted as
  minutes the market was actually **open**, so overnight gaps, weekends, holidays
  and half-day afternoons contribute nothing (holidays and early closes since
  2026-09-05; before that a position carried over one arrived at the next open
  already past its bar) — is scratched at market through the same
  careful cancel-bracket-then-close path, freeing its concurrent-position slot and
  its share of the open-risk budget for fresh signals (the journal showed two
  stalled positions once blocking ~1,000 candidate checks in two hours). Progress is
  measured against the trade's own stop distance, a slow *bleeder* below the bar is
  recycled too, and a position with no stop is never scratched on a guess. Every
  scratch journals its held time and R (`live_time_exit_placed` with
  `trigger: "stagnation"`), so you can audit whether it's cutting losers or
  winners. Their end-of-session sibling is the **end-of-day flatten**
  (2026-08-25, default off): set it to a number of **minutes
  before the 16:00 ET close** and every open live position is closed through
  that same cancel-bracket-then-close path rather than carried overnight —
  **live options positions too**, which since 2026-08-25 also honour **max hold
  days** (see "Live options trading" below). Since 2026-09-05 the **paper**
  equity book flattens on the same window and the same setting: not for risk (a
  simulated overnight hold costs nothing) but so paper measures the strategy
  live actually runs. Without it every paper position opened late in the session
  necessarily became an overnight hold — all twelve such trades were carried,
  ten stopped out the next morning, and those alone accounted for more than the
  paper book's entire net loss. Paper copies the exits that are **structural**
  — the ones live applies to every position whatever the trade is doing — and
  deliberately leaves off the three rules that are themselves the open question:
  the **entry cutoff**, the **stagnation exit** and the **symbol re-entry
  cooldown**. Paper keeps taking those trades and now exits them the way live
  would, which is the only way to find out what each of those three rules is
  actually buying — live can't answer that about itself, since it closed the
  trade. Anything else that differs between the two books is a bug, not a
  comparison.
  Since 2026-09-05 the flatten (and every other session gate) also knows
  **market holidays and early closes**: the loop is idle all day on a full
  holiday instead of trading off the previous session's stale closes, and on a
  half-day it flattens against the **13:00** bell rather than 16:00. Before
  that, a half-day's flatten fired at 15:55 — nearly three hours after the
  market shut — cancelling a live position's protective bracket and leaving it
  naked overnight. The calendar is hand-maintained and **announces its own
  expiry**: a test fails once the clock passes the last date it covers, so a
  stale table can't quietly start treating holidays as trading days again.
  It
  Since 2026-08-28 the flatten also closes the **entry** side of that window:
  no new live equity position opens within **the flatten window plus a runway**
  of the close. Since 2026-09-02 that runway is **however long the stagnation
  exit needs to reach a verdict** (**Stagnation exit minutes**, 90 by default),
  floored at 15 minutes for a book running with stagnation off — so a 5-minute
  flatten with a 90-minute stagnation window stops new entries from **14:25**.
  The runway used to be a flat 15 minutes, which asked whether a trade could
  reach its *target*; but the target is not what closes most of these trades,
  the stagnation rule is, and a position opened with less time than that rule
  needs is decided by the clock instead of by its thesis. One
  refusal is journalled per batch as `entry_window_closed`. Without it the loop
  could open a position the flatten immediately closed — on 2026-08-28 it opened
  ESTC at 15:56:04 and flattened it at 15:57:12, 68 seconds later, after another
  position's flatten had freed the slot. The cost is not the cents: a position
  opened that late **cannot** reach its stop or target, so it spends a
  concurrency slot and one of the day's trades on a coin flip. The cutoff is
  derived from the flatten rather than set separately, so the two can never
  disagree, and it disables itself along with the flatten.

- **"Why wasn't this traded today?"** — `GET /api/autotrade/explain/:symbol` answers it for
  any symbol, on demand. The screener journals *some* rejections per symbol (real estate,
  relative-volume pace, volatility, earnings, unknown sector) and says nothing about the
  filters inside the score — today's move, the score minimum, weekly-trend alignment,
  price, average volume. Those reasons were computed and dropped, so a name that simply
  never appeared left no trace of what stopped it. This runs a **real screen over the whole
  universe** and reports where your symbol landed: `candidate`, `rejected_by_filters` (with
  the exact reasons), `excluded`, `skipped`, `error`, `not_scanned`, or `not_in_universe` —
  along with the score, the pace denominator the reasons were measured against, and both
  the screen minimum and the live conviction floor. It screens everything rather than the
  one name deliberately: relative-volume *pace* is a multiple of the universe's median that
  tick, so a one-symbol screen would make every pace exactly 1.0× and the answer would stop
  matching what the loop does. Nothing is journaled — it is a question you ask, not a query
  you had to anticipate.

  fires on **working positions too** — the decision is about the clock, not the
  trade, since a winner gaps down as easily as a loser — and it never runs after
  the bell, because closing into after-hours liquidity pays a wide spread to
  avoid a gap you're already exposed to. It also **replaces a resting exit order
  placed before the window**: a limit priced off an earlier quote can sit
  unfilled while the market walks away from it, which is how a position ends up
  carried by an exit that already decided to leave. Journaled as
  `trigger: "end_of_day"` with the minutes left and whether it replaced a
  resting order. Five more fields manage an
  already-open equity position the same way a discretionary trader might. All
  five run on **paper and backtest**, and since 2026-08-26 all five can reach
  **live** equity too — each behind its own switch, because these values were
  set long ago for the paper path and must not start moving real money just by
  being non-zero: the two partial-exit fields via **live scale-out**, and the
  three stop fields below via **live trailing** (both default off). Before
  those switches existed a live position kept one fixed stop for its whole
  life while these settings read as active. The fields: **breakeven trigger**
  (once unrealized gain reaches this many R, move the
  stop to exactly the entry price — a one-time move, never applied if it would
  loosen the current stop), **trailing start** and **trailing distance** (once gain
  reaches the trailing-start R-multiple, the stop trails the trailing-distance R
  behind the best price seen since entry, ratcheting only favorably — independent of
  the breakeven trigger), and **partial exit trigger** with **partial exit size (%)**
  (once gain reaches the trigger, close that percentage of the position once — the
  rest keeps running toward its original target or continues trailing). All five
  default to **0 (disabled)**, except partial exit size, which defaults to 50% for
  whenever its trigger gets turned on — so leaving them untouched changes nothing.
  R-multiples here are always measured against the position's own original stop
  distance, fixed at entry, even after the stop itself has since moved.
  A paper scale-out **banks** the closed slice's P&L onto the position
  (`realizedPartialPnl`), and every P&L figure the app shows for that trade —
  the row, the day's realized total, the journal event, the per-grade edge
  report — is the banked slices **plus** whatever the remainder finally made.
  Before 2026-09-05 the slice was recorded only as a journal line and no P&L
  read included it, so a trade that took 67% off at +0.25R and then trailed to
  breakeven displayed as a **$0 scratch** rather than the winner it was; since
  the scale-out only fires at a profit, the error only ever ran one way. The
  existing history was repaired from those journal lines when the fix shipped
  ($356.99 across 17 of 70 closed paper trades).
  On a **live** position the stop is not a number in a database but a resting
  **STOP_LOSS** order at the broker, so a ratchet is a *replace* on that leg —
  atomic, so the position is never momentarily unprotected. Two consequences
  worth knowing: only the stop leg moves (never the take-profit leg, which if
  dragged onto the price would sell the position outright), and the local
  record is updated **only after the broker confirms** — a refused or
  uncertain replace leaves the old stop standing and is journaled as
  `live_stop_adjust_failed`. If the resting stop leg cannot be positively
  identified — no order labelled `STOP_LOSS`, or two of them — the ratchet
  refuses rather than guessing (`live_stop_adjust_blocked`) and retries next
  cycle. A successful move journals `live_stop_ratcheted` with which rule
  fired, the old and new stop, and the R it fired at.
- **Scale into winners** (2026-07-23, **paper + backtest** equity only — live is
  untouched) — three more fields let a _winning_ position **pyramid**: **scale-in
  trigger (R-multiple)** (once unrealized gain reaches this many R, add more shares),
  **scale-in size (% of current)** (how big each add is, as a % of the current
  quantity), and **max add-ons** (a hard cap on how many times one position may be
  added to). Each add **blends the entry** toward the current price, **shifts the
  recorded initial-stop level by the same amount** so the R-multiple denominator stays
  the _original_ per-share risk (which naturally spaces the adds ~1R apart), and
  **raises the protective stop** to 1R below the new blended entry — never loosening
  it. A scale-in never fires in the same cycle as a partial scale-out. All three
  default to **0/off** (max add-ons 0 ⇒ disabled), so leaving them alone changes
  nothing. It's an edge _amplifier_, not a signal — validate it in the backtester
  before trusting it. This is the one place the app _adds_ risk to a live-feeling
  paper position, which is exactly why it's capped and paper/backtest-only.
  Seven more fields do the same for an already-open **options** position:
  **Options stop-loss (%)** and **Options take-profit (%)** close the position
  once unrealized loss/gain reaches that % of premium paid (net debit, for a
  spread) — and since **2026-07-26 these two apply to LIVE options positions
  too**, not just paper/backtest: when either fires on a live position, the
  loop places a real closing order (the same separate sell-to-close it already
  places for a time-exit — never a bracket leg), records the reason
  (`stop_loss` / `take_profit`), and skips re-triggering while that close is
  still working. Before this, a live long option's only automated exit was the
  7-days-to-expiry time exit — it could ride to worthless with no brake. Live
  evaluation fetches a fresh mark each cycle **only when a price rule is
  actually set** (0 keeps the original no-quote, time-only behavior); a cycle
  whose quote is unavailable or unusable skips the price rules that cycle
  (never fabricating a trigger) and the time exit remains the backstop. The
  remaining five stay **paper/backtest-only** and
  mirror the equity breakeven/trailing/partial-exit fields above, but in
  percentage-of-premium terms rather than R-multiples — a long option/spread has
  no ATR-based stop price to measure R against: **Options breakeven trigger (%)**
  (once unrealized gain reaches this %, move the stop-loss floor to breakeven —
  a one-time move, never applied if it would loosen an already-ratcheted floor),
  **Options trailing start (%)** and **Options trailing distance (%)** (once gain
  reaches the trailing-start %, the floor trails the trailing-distance percentage
  points behind the best gain % seen since entry, ratcheting only favorably —
  independent of the breakeven trigger), and **Options partial exit trigger (%)**
  with **Options partial exit size (%)** (once gain reaches the trigger, close
  that percentage of the contracts once — the rest keeps running toward its
  original take-profit or continues trailing). All seven default to
  **0 (disabled)**, except partial exit size, which defaults to 50% for whenever
  its trigger gets turned on — leaving them untouched changes nothing, and the
  loop's only automated options exit stays time-based (closing as expiration
  approaches, see "Options paper positions" below).
  As on the equity side, an options scale-out **banks** the closed slice's P&L
  onto the position, and every P&L figure for that trade is the banked slices
  plus whatever the remainder made. (This book had not yet taken a single
  partial when that was wired in on 2026-09-05 — it was fixed here before it
  could cost anything, after the equity book lost $356.99 to the same gap.)
  **Options entry rules** control the contract-quality screen the options decision
  stage runs on every candidate **before** risk-check ever sees it — a candidate that
  fails here is what shows up in **Recent activity** as `No contract passed entry
  rules (liquidity/spread/delta/IV band)`. **Options delta band (min/max)** bound a
  contract's absolute delta (0-1) — lower is further out-of-the-money (cheaper
  premium, lower probability of expiring in the money), higher is closer to the
  money. **Options max spread (%)** caps (ask − bid) / mid; **options min open
  interest** and **options min volume** are independent liquidity floors; **options
  min/max days to expiration** bound the DTE window a contract's expiration must fall
  within — counted in **whole calendar days on the US-market calendar**, so from a
  Wednesday a Friday expiry is 2 and a same-day expiry is 0, at any hour of the
  session (before 2026-09-02 these were compared against fractional time-to-expiry
  instead, which scored that same Friday contract 2.27 and put it outside a 0-2
  window until Thursday — on a weekly-expiry name, which is most of the market,
  options could only ever open on Thursday and Friday); **options IV rank ceiling** skips an underlying whose IV rank (0-100)
  exceeds it — this loop only ever buys premium, so guarding against an
  already-expensive underlying is the direction that matters — and **options IV rank
  floor** (2026-07-27) is the other end of that same band, 0 = no floor. **Options
  max IV/RV ratio** (2026-07-27, 0 = off) is a cheapness gate on the underlying
  rather than a per-contract rule: skip the options entry when today's at-the-money
  implied volatility exceeds this multiple of the underlying's own 20-day realized
  volatility — buy premium only when it's cheap relative to how the stock actually
  moves, not merely low within its own range (~1.0 means "implied no richer than
  realized"). When the gate is on but realized volatility can't be computed (too
  little daily history), the candidate is skipped rather than guessed at; a passing
  candidate's rationale records the ratio. All ten default to the values these
  checks always used before they were configurable (delta 0.30-0.60, max spread
  10%, min open interest 100, min volume 10, DTE 7-60 days, IV rank ceiling 70,
  floor 0, IV/RV gate off), so leaving them untouched changes nothing; the manual
  Screen/Decision preview below defaults to these same saved values too. Backtesting
  is unaffected by what's SAVED here — options backtests keep using the original
  fixed constants unless a request supplies its own values, the same
  self-contained-hypothesis convention every other screening/decision field in this
  section already follows (the backtest API accepts the IV rank floor and IV/RV
  ratio too, so the gate can be tested before it's trusted).
  **Auto-promote recurring movers** (on by default) grows your universe automatically:
  a symbol Webull's premarket movers surface that also clears screening on **3 distinct
  days within a 10-day window** (both tunable, along with a **50-symbol lifetime cap** on
  how many this can add) earns a permanent spot in your universe — the same list the
  **Screener** page's **Manage universe** edits — so a genuinely active name stops being
  re-discovered and re-scored from scratch every day. Only ever runs from the background
  loop, never from a manual **Run screen**; each promotion shows up in **Recent
  activity**, and once added, a symbol you later remove is never re-added by this
  mechanism. Note what the threshold actually counts: a mover has to **pass screening**
  on each of those days to earn an occurrence, so the promotion rate is bounded by how
  many movers survive your filters, not by how many the provider returns. A failed
  movers fetch now also logs a **movers fetch failed** entry in **Recent activity**
  (once per day per distinct error, so a day-long outage doesn't flood the feed) —
  screening continues universe-only, but no occurrences accrue while it's down.
  **Auto-tune from realized edge** (2026-07-18, off by default) closes the loop between
  the Journal's own analytics and what the loop actually does: once a day, it nudges
  **risk-per-trade** toward a Kelly suggestion computed over the **loop's own
  (autotrade-tagged) closed trades only** — since 2026-08-21 your manual trades are
  invisible to it, because rule-based exits produce a different return shape than
  discretionary ones and the loop must be sized on its own discipline, not yours
  (same quarter-Kelly, 3%-capped math the Journal shows, just on the narrower
  population), and auto-excludes any symbol whose average live-fill slippage
  crosses a threshold — both gated on a configurable minimum sample size so a handful of
  trades can't move things, and the risk change is capped per day so one noisy reading
  can't swing live sizing. On top of that, a **walk-forward guard** — **Require
  out-of-sample confirmation before raising risk** (2026-07-24, **on by default**) — only
  lets it _raise_ risk-per-trade if the edge still holds out-of-sample: the most recent
  half of the loop's own closed trades must be a large-enough sample whose expectancy confidence
  interval sits entirely above zero (the same bootstrap the backtest's significance panel
  uses). A _cut_ is always applied — down is the safe direction — but an in-sample edge
  that hasn't held up on recent trades won't talk the loop into sizing up; a blocked
  increase is journaled with its reason. Turn it off only if you deliberately want the
  Kelly nudge to raise risk on the full-history edge alone.

  **If a cut ever lands on 0%, that is a halt, and it says so.** Risk-per-trade is
  floored at 0, and at 0% every position sizes to 0 shares — the loop opens nothing at
  all. That happened once, on 2026-08-09, at the end of a four-night run of cuts, and it
  was announced as an ordinary "risk-per-trade adjusted" reading `0.24% → 0%`. It now
  gets its own journal entry (`auto_tune_book_halted`) and its own push, saying plainly
  that the book will open nothing and that **you have to set risk-per-trade by hand to
  resume**. Auto-tune cannot undo it on its own: raising risk needs the walk-forward
  guard to pass, that guard reads _closed_ trades, and at 0% no new trades ever close —
  so the evidence it waits for can never arrive. A symbol it excludes lands on the same exclusion list your
  manual entries use (Settings), so it's visible and reversible there, not a hidden
  blocklist. A separate, independently-toggled **Also auto-tune exit geometry** (2026-07-24,
  off by default) extends the same once-a-day pass to your **stop (× ATR)** and **target
  (R)**: it reads the **MAE/MFE** of your _winning_ autotrade trades — how much heat a good
  trade actually took sizes the stop, how far it actually ran sizes the target — and nudges
  each toward that, capped per day by its own **max exit step** so one sample can't swing
  your exits. Winners only, deliberately: a stopped-out loser can't tell you whether a
  different stop was better. It also only reads trades **entered since its last change**:
  both signals are measured against each trade's own stop at entry, so a trade taken under
  the previous geometry can't judge the one that replaced it — re-reading them would keep
  re-applying a correction it had already made, walking your stop toward its floor. After
  an adjustment it waits for enough fresh trades to close before moving again. Every adjustment shows up in **Recent activity** the moment it happens, and
  also pushes a notification through your configured webhooks (see **Alerts** below) —
  a live change to what the loop does is worth more than a line you'd only see if you
  went looking. See `docs/STRATEGY_PLAYBOOK.md`'s sizing and execution-quality sections
  for how to read the numbers this is reacting to.
  The **kill switch** button above these settings is a separate, sticky
  emergency halt —
  engaging it (one click, no confirmation needed, mirroring the same button on the
  **Trade** page) blocks all new entries immediately, regardless of the enabled toggle
  or session window, but does **not** close your existing paper positions — their
  stop/target levels keep being checked every cycle, exactly as if you'd left the loop
  running. Releasing it resumes the loop automatically if **enabled** is still checked;
  it doesn't touch that setting either way.
- **Live trading** — configure and arm the loop to place **real** orders through Webull.
  Set a **Webull account ID** (server-side only — unlike the Trade page, never sourced
  from your browser) and the **live guardrail caps**: max order size ($), **max gross
  exposure (% of equity)**, **day buying power ($)**, max daily loss
  ($), max orders/day, fat-finger %, and whether to **allow naked-short exposure**
  (leave unchecked unless **Trade direction** above is `Short` or `Both` — every other
  position this app can take live is defined-risk (long stock, long calls, long puts),
  so this stays off by default; check it only once you've deliberately decided you want
  the loop opening real, uncapped-downside equity shorts, not just paper-trading them).
  **Suggest from
  equity** fills the first three of those from your account equity and the configured
  daily-drawdown %/max-trades-per-day (25% of equity for the order cap on the moderate
  profile, 35% on aggressive — the same fractions **Tune from target** uses, so
  suggesting after a tune can't quietly replace the tune's own order cap; the other two
  match those settings exactly) — a starting point only, so it fills the
  fields without saving them; review or edit before clicking **Save live-trading
  settings** below.

  Two of those caps decide whether a **second** position can open while a first is
  still on, which matters most in the morning when volume and direction are
  strongest. **Max gross exposure** was fixed at 100% of equity until 2026-08-27, on
  the reasoning that a cash account cannot hold more than it is worth — true, and it
  left no headroom at all: two correctly-sized positions came to $2,284 against a
  $2,283.61 cap and the second was refused by 39 cents. **Day buying power** exists
because the loop is the only caller that is always flat by the bell, so it is
  the only one entitled to the account's **day-trading** buying power rather than its
  overnight figure. That comes straight from the broker now (`day_buying_power` — 4×
  net liquidation on a PDT-flagged margin account), so there is nothing to type in and
  nothing to go stale. Leave the setting at **0** to use whatever the broker reports;
  set a positive number to cap it — "never deploy more than $X intraday however much
  margin is extended". It only ever *raises* what the guardrail would otherwise have
  used, so a cap can never block an order the account could already fund.

  This mattered more than it sounds: until 2026-08-27 the app read a `buying_power`
  key that the account **does not return**, silently fell back to the cash balance,
  and so reported roughly a quarter of the real capacity. Live entries were refused
  for funds that were sitting there — blocked against "$1,005.46 available" on a day
  the account had close to $4,000 of day buying power.

  A further setting guards the equity feed itself. **Max equity-sync jump (%)**
  refuses a synced net-liquidation reading that moves more than that from the last
  accepted one; a rejected reading is journaled as `equity_sync_rejected` and the last
  confirmed figure is kept, while a reading that **repeats** at the same new level is
  accepted after three ticks so a deposit or an overnight gap still lands. Set it
  generously — it was built on the belief that a wildly swinging feed was corrupt, and
  the swings turned out to be a hand-traded options position marking to market, so on
  an account where you trade options by hand a 5–10% move between ticks is ordinary
  and real. It should only ever catch an absurd print. 0 disables it. Independently,
  banking the day needs the target met on **two consecutive ticks**, so a one-tick
  spike cannot end a session; and **POST `/api/autotrade/daily-target/reset`** clears
  the sticky halt flags if a day is spoiled anyway — pass `baselineEquityUsd` to
  re-base the day, because a reach is recomputed as "flag set OR equity above target"
  and the next tick otherwise re-trips it.

  Needs account equity set first (Configuration, above). A **probation**
  setting cuts position size (e.g. to half) for the first N live trades after you enable
  it, on top of whatever the configured risk-per-trade % and any loss-streak step-down
  already produce — save these before enabling. Your **paper track record** (trade count, win rate, date
  range) is shown for you to review first — it's informational only, not an enforced
  gate. To actually go live, type the exact phrase shown (**ENABLE LIVE TRADING**) into
  the confirmation box — a one-time, deliberate gesture, not a per-order one: once
  enabled, the loop places real orders on its own schedule with no further confirmation.
  Turning it back **off** needs no confirmation, just a click. Live orders go out as
  **bracket orders** (an entry plus linked stop-loss and take-profit), so your stop/target
  are enforced by the broker directly. Live trading is blocked if *either* kill switch is
  engaged — this page's own, or the **Trade** page's — since both places orders through
  the same real account; either one's "Halt trading" is a genuine, shared emergency stop.
  An engaged kill switch freezes **all** automated live order placement — exits included,
  not just entries — which makes it the right tool for "hands off, I'm trading this
  account manually in Webull": the app won't fire its own closes into your session.
  Three things keep working through a halt: your **broker-side bracket legs** still rest
  at Webull and fire on their own; the background **sync keeps booking** whatever fills
  or manual closes happen at the broker (a held options exit is journaled to Recent
  activity **once per halt** — visible without repeating every tick; equity time-exit
  blocks still journal per attempt, since those feed the failure alert); and **paper**
  positions keep exiting normally, since they touch no broker. Releasing the switch
  resumes automated exit management immediately.
  A live order that fills only **partly** is recorded as soon as the loop sees it, rather
  than waiting for the order to complete — and later instalments of the same order are
  blended into that one position (bigger size, averaged entry), not opened as a second row.
  This matters because an autotrade order that is cancelled after filling partly stops
  being polled for good, so anything not recorded at that moment would never be recorded at
  all. If the broker reports a fill the loop can't fully record — more filled than was
  ordered, say — it records only what it can justify and journals a
  **`live_fill_not_fully_materialized`** entry on **Recent activity** explaining the
  difference. It deliberately errs toward recording **less** rather than inflating a
  position's size or cost basis, since every risk figure on this page is derived from those
  numbers; treat such an entry as "check this order against the broker".

  A **Live positions** table (Dashboard tab) shows every real position the loop has actually
  placed — the exact same `positions` rows your own manual trades use on the
  **Positions**/**Journal** pages, filtered here to just autotrade's own fills (tagged
  server-side, not a separate table the way paper trading is). Shows the same open/closed
  counts and realized/unrealized P&L stat tiles as the paper tables, plus each position's
  live price/mark, quantity (showing the remaining fraction once partially closed), P&L,
  and R-multiple — stock and option positions both render here, with option contract
  details (strike/type/expiration) shown inline. A position that has **pyramided** (see
  _Scale into live winners_ below) carries a small **+N add** badge next to its symbol, so
  you can tell at a glance which live positions were scaled into and how many times. This is
  the dedicated place to see your real autotrade fills at a glance; they also appear, unmarked, mixed in with your manual
  trades on the Positions/Journal pages and the Trade page's Orders panel. Kept accurate
  every cycle by a broker-truth check (diffs against what Webull actually shows open) as
  a backstop for anything a specific order's own status doesn't catch on its own — no
  separate setup needed, unlike the general Webull position sync under Settings. Each open
  row has a **close** button that places a **real** closing order for that position right
  now (the same one the **Positions** page offers, since these are the same rows): it opens
  a confirmation modal where you type `SELL <qty> <symbol>` (or `BUY …` for a short) to arm,
  cancels any resting stop/target bracket first, then submits a marketable-limit order
  through the identical guardrail + kill-switch checks as any other live order. It doesn't
  wait for the automated exit — use it to bail out of a position on your own read.
- **Live options trading** — a checkbox nested under **Live trading** above (only shown
  once live trading itself is enabled) that lets the loop place real **single-leg**
  (long call/put) and **debit-spread** options orders through Webull — no second
  confirmation phrase; the live-trading phrase above already covers "real money is now
  live." Its own dedicated **guardrail caps** (max order, max daily loss, max
  orders/day, fat-finger %) and **probation** window, separate from the equity live
  caps above, since options can go live weeks after equity and size differently
  (premium-based, not share-count-based). Note that **probation cannot cut below one
  contract** — a contract is indivisible, so where the size cut would round an approved
  single contract down to nothing, the entry goes out at that one contract and logs
  **options probation at minimum** in **Recent activity** instead. Before 2026-09-02 it
  rounded to zero and refused the entry, which meant switching probation on quietly
  turned the options book off entirely. A single-leg entry places a plain limit
  order; a debit spread places **one** combo order for both legs together, never two
  separate orders. Both **skip any contract with no live bid/ask** — where the only price
  available is an old last-trade print, an entry is declined rather than opened at a limit
  derived from it (the skip is journaled with the reason). The automated exits are the same
  close-only rules paper options trading already uses — the always-on **time exit** near
  expiry, plus (2026-07-26) the configured **Options stop-loss (%)** / **Options
  take-profit (%)** — but here a trigger places a **real** closing order (a single-leg
  sell, or both spread legs together as one combo) instead of just recording a paper
  close, with the reason (`stop_loss` / `take_profit` / `time_exit`) recorded on the
  exit and shown by the table's Reason badge. Since 2026-08-25 live options also
  honour the two **intraday** time rules equity already did — **max hold days**
  and the **end-of-day flatten** — using those same settings rather than
  options-specific ones. Before that the only time rule here was the
  days-to-expiry backstop, so a contract bought at 14-60 DTE could be held for
  weeks while holding a slot in the concurrent-position budget both books share.
  Each fires regardless of how the position is doing, is journaled as
  `live_options_intraday_exit` with its `trigger` (`end_of_day` or
  `max_hold_days`), and books the close as `time_exit` — unless a stop-loss or
  take-profit fires in the same cycle, which keeps its own reason. The
  **stagnation exit** stays equity-only on purpose: a long option that goes
  nowhere is already paying for its slot through theta. Unlike equity's flatten,
  this one does **not** re-price a closing order that is already working: an
  options close is priced 5% through the mark (against equity's 0.5%), so a
  resting one is far likelier to fill than to be left behind. There's never a resting bracket: a live
  options exit is always a fresh closing order the loop places when its rule fires. An exit
  makes the *opposite* call on a stale price: it still places (declining would just leave
  the position drifting to expiration, which is what the time exit exists to prevent) but
  journals that the close may rest unfilled, which feeds the unresolved-order alert below.
  If a position does reach **expiry** still open — an option held through expiration never
  produces a closing order, and the broker-truth backstop can't price a chain that no
  longer exists — it's swept the same way the [Positions](#positions--pl) page's expired-option
  sweep works: one that finished clearly **out of the money** is closed at **$0** (that's a
  statement of fact, not a guess), while one that finished **in the money**, or too close to
  the strike to call, is **left open and flagged** — it was exercised or assigned into a stock
  position this app doesn't track, so it needs your broker statement. For a debit spread both
  legs must finish out of the money before it's booked at $0; either leg finishing in the money
  means assignment, and that's a human's call. This matters beyond tidiness: an expired row left
  open counts against the shared open-risk budget both the equity and options books draw from,
  and blocks any new options entry on that underlying. A **Live options positions** table (Dashboard
  tab, below the equity Live positions table) shows every real options position the loop has
  placed, with the same side/strike badges (and both strikes for a spread) as the
  options paper table. Kept accurate every cycle by the same kind of broker-truth
  backstop the equity table uses — for a spread, both legs have to be confirmed gone
  at the broker before it's marked closed; one leg missing on its own is left open
  rather than guessed. Each open row also has a **close** button, the options
  counterpart to the equity one above: type `SELL <qty> <symbol>` to arm, and it places
  a real closing order right now — a sell-to-close for a single leg, or the whole spread
  as one combo (selling the long leg, buying back the short) — through the same
  guardrails and kill-switch checks — including the same amber **⚠ Outcome unknown**
  result, and the same "don't close again until it resolves" rule, described under
  [Positions & P&L](#positions--pl). A close you trigger this way is recorded as a
  **manual** exit (vs. the automated **time exit**), so the table's Reason badge tells
  the two apart.
- **Scale into live winners** (2026-07-24) — a checkbox in the live-trading settings (with a
  **max live add-ons** cap you can set below the paper one), **off by default** and gated
  behind live trading being enabled. When on, it applies the **same** scale-in trigger / size
  (from **Equity exits**) to real positions: once a live winner reaches the trigger R, the
  loop adds shares. It's the one live setting that _adds_ risk to an already-open position, so
  it's built to never leave the position unprotected — each add is placed as its **own
  bracket** (the added shares get a raised stop at ~1R below the new blended entry, plus the
  position's target), and your **original bracket is never touched**. The add's fill then
  merges into the position (blended cost basis, larger size); the result is a live position on
  **two stops** — original shares at the original stop, added shares at the tighter one — which
  stops the newer shares out first on a pullback. It runs behind the same kill-switch / market-
  hours / guardrail gates as a fresh entry, fails closed on any hiccup (logged, skipped, never
  a naked position), and pushes a **scale-in** notification. The **Live positions** table then
  badges that position with a **+N add** count so a pyramid is visible at a glance. Like the
  rest of the live-order surface, treat the first few real adds as confirmation before trusting
  it with size — **validate in paper + backtest first.**
- **Stop-still-there check** — a bracket is submitted as one request (entry plus its
  stop/target), and the broker's reply doesn't say whether the *exit legs* were accepted, only
  that the request as a whole was. So if Webull ever takes the entry and drops the exits, the
  position is unprotected while this app still shows a stop price against it. Every cycle the
  loop asks the one question the broker can answer — is there a resting exit-side order on that
  symbol? — for each live **stock** position opened with a bracket, and alerts on any that has
  none. It only ever **reports**: placing a replacement stop automatically would risk a second
  stop on the same position if the check simply failed to see the first, and two stops on one
  position sell it twice. Re-arm by hand at the broker. (Options are excluded on purpose:
  Webull only allows DAY orders on the option sell side, so an option bracket's exits
  legitimately disappear at each close, and checking them would alarm every day for a known,
  separate limitation. Autotrade's options path never places brackets at all.)
- **Alerts** — a few loop events push a notification through whichever webhooks you've
  configured in [Settings → Server-side watching](#server-side-watching-alerts-with-the-app-closed)
  (Slack/Discord/generic) — the same destinations the price-alert poller uses, so
  nothing new to set up. A **live order placed** notifies with the symbol, side,
  quantity, and limit/stop/target; **engaging** the kill switch notifies too (releasing
  it doesn't — that's the safe direction); and if **live orders keep getting rejected**
  (three in a row — a bad price, a broker/account problem, a config error, so no live
  trades are getting through), you get one alert naming the count and the latest reason,
  then at most one reminder an hour while it persists, reset the moment an order gets
  through. Separately, an **unresolved order state** alerts on the *first* occurrence —
  a placement the broker never answered, a fill the app couldn't fully book into its
  ledger, an order retired because the broker denied knowing it, a bracket whose
  stop and target *both* reported filled, an order status the app doesn't recognize,
  a closing order priced off a stale last trade that may rest unfilled, an options
  position that expired in the money, or a live position the broker shows **no resting
  stop** for. These
  aren't rejections and a later successful order doesn't undo them: each one means
  the app's records and your broker may already disagree, so the alert says which
  and points you at the Auto-Trade journal. Throttled to at most one an hour, and it
  only ever reports what's new since the last one — so it goes quiet on its own once
  they stop.
  The **daily-drawdown halt** also notifies — paper, live, and live options
  each alert independently the first time that book's day crosses its own halt level,
  at most once per (ET) trading day per book, so a rough day in one doesn't drown out or
  suppress a rough day in another; releasing the next day (a fresh day's P&L starting
  over) needs no alert of its own, same reasoning as the kill switch's release. A
  **stock split** on a symbol with an open autotrade position (paper or live, stocks
  or options) also notifies — checked at most once a day, since splits are rare and
  the underlying lookup is Yahoo-only (real detection needs `MARKET_DATA_PROVIDER` on
  Yahoo or not — this specific check always uses Yahoo regardless, the same
  provider-agnostic convention the earnings/ex-dividend lookup already follows; it
  simply never finds anything real if you're on Tradier or Webull for everything else,
  same as it never does under the `mock` demo provider). This is detection only — it
  does **not** adjust the position's own quantity or price; treat it as a prompt to go
  check and fix that position yourself. **Auto-tune from realized edge** (see Config tab,
  below) also notifies for each of its own two actions — a risk-per-trade adjustment
  names the old/new percentage and the Kelly suggestion behind it, and a symbol
  exclusion names the symbol and the slippage reading that triggered it — since both
  change what the loop does going forward, not just something worth a quiet log line.
  All alerts here are best-effort: with no webhook configured, nothing is sent and
  nothing fails.
- **Refresh** (top of the page, next to the title) — Monitoring, Paper trading, and
  Recent activity all reflect state the background loop can change on its own, every
  minute, with nothing clicked — unlike Configuration, the exclusion list, and the
  backtest tool, which only change in response to a direct action. One shared control
  covers all three: a manual **Refresh** always works, and an **Auto** dropdown controls
  polling (off/10s/30s/1m/5m) — defaults to **every 1 minute**, same as everywhere else in
  this app that offers polling; pick **Off** if you'd rather refresh by hand.
- **Monitoring** — a **Last cycle** summary sits at the top: when the automated loop
  most recently ran, how many candidates it screened → passed the volatility filter →
  turned into signals (equity and options), how many paper/live entries it opened, how
  many exits it checked/closed, and any movers promoted that cycle — persisted from the
  actual last tick (not recomputed), so it reads "hasn't run yet" only before the loop's
  very first cycle, and survives the page being closed and reopened. The same line now
  reports **how many of the premarket movers fetched actually became candidates**
  ("Movers discovery contributed 1 of 35 fetched"), or, if the fetch itself failed, says
  so in amber with the reason. Read the pair together: a high fetched count with zero
  contributed means discovery is working and the gappers it finds aren't passing your
  screening filters — most often the **min price** floor, since premarket movers skew
  heavily sub-$5 — while a fetch error means the movers half of discovery is off the air
  entirely and screening is running universe-only. Before this, both cases looked
  identical from every page in the app, which is how zero auto-promotions over two weeks
  went unexplained. If that cycle
  didn't place any entries, the exact reason (kill switch engaged, market closed,
  within the session buffer, etc.) shows first, in place of the funnel. Below that, a **Books**
  table reads the loop's current state directly — one row per metric, one column per
  book (**Paper**, **Live equity**, **Live options**), with a ●/○ marker under each book
  name showing whether that book is currently trading. The three books are three
  separate pools: each risk-checks against only its own numbers, matching how the loop
  really enforces the caps, so the columns are never added together. The caps themselves
  *are* shared, so each is written once in the row header instead of three times across
  the row: **open positions** vs. the configured concurrent-position cap
  (Configuration's "max concurrent positions," not the risk profile — see above),
  **aggregate open risk** vs. its $ cap, **day P&L** vs. the $ level that would trigger
  the daily-drawdown halt, **trades today** vs. the daily cap, the **consecutive-loss
  streak** vs. the count that triggers step-down sizing, and **probation** — the size cut
  and trades remaining while it's active, which is live-only, so paper's cell is an
  explicit dash rather than a blank. A cell goes red once its cap is reached; the day P&L
  cell specifically shows a distinct "HALT TRIGGERED" label (not just its ordinary
  red-for-a-loss coloring) once that book's daily-drawdown halt is actually breached, so
  an ordinary down day and a halted one are never hard to tell apart. Only the **Paper**
  column folds equity and options into one pool — its header says so, and its
  open-positions and open-risk cells carry a sub-label breaking the combined number back
  out into its equity/options parts; the two live columns are each their own pool. Every
  figure in the table is a direct read of the same numbers the risk engine itself checks
  before approving a trade — this panel can't show you something the risk engine would
  disagree with. Below the table, an **Account-wide** row holds the three figures that
  aren't per-book: the active **risk profile** (and whether the loop is running or the
  kill switch is engaged), **correlated exposure**, and **sector exposure**. Correlated
  exposure is the one exception to "live gauge" above — correlation is relative to a
  specific candidate, not a single portfolio-wide number, so instead it shows the **last
  candidate actually risk-checked** against this cap: its symbol, the $ amount already
  correlated, how long ago, and a red **BLOCKED** flag if that check is what stopped it —
  reading "no candidate checked yet" until the loop (or a manual **Run screen**) has
  evaluated at least one. The **sector exposure** tile next to it is back to a live
  gauge — sector is a fixed classification, not relative to a hypothetical candidate, so
  it shows the single most-concentrated sector across your whole current book (paper +
  live, stocks + options combined) vs. its $ cap right now, flagged red if already over.
  Below those, a **Portfolio Greeks** section shows net delta, theta, and vega summed
  across your whole combined open options book (paper + live) — "am I net long or short
  the market right now" and "how much am I bleeding or collecting in time decay today,"
  one $ number each, instead of only ever seeing Greeks per-contract on the Options
  page's own chain browser. Unlike everything above it (a pure database read), this needs
  a live options-chain fetch, so it loads once when you open the Dashboard tab and only
  refetches when you click its own **Reload Greeks** button — it does not ride the
  60-second poll the rest of this panel uses, to avoid an options-chain round-trip on
  every automatic refresh. A debit spread's short leg is netted against its long leg
  (you're short that contract, so its Greeks subtract rather than add) — every other
  position in this app is a plain long-the-contract bet. Whenever any options paper
  positions are open, an **Options expirations** list appears below, sorted
  soonest-first, so you can see an upcoming expiration (and the automated close-only exit
  that's coming for it) before it happens — a position within a week of expiring is
  flagged in red.
- **Real-estate exclusion list** — real estate is a hard, permanent exclusion for this
  strategy. A starter list of well-known real-estate ETFs ships seeded in; add or remove
  symbols freely. This list is a backstop, not the only check — the screen (Dashboard
  tab) also classifies every candidate by sector/industry, so REITs and real-estate operating
  companies that aren't on the list (e.g. cell-tower or data-center REITs) still get
  caught.
- **Macro event blackout list** (2026-07-18) — the dates/times **macro event blackout
  (hours)** above checks against. Unlike the exclusion list above, nothing ships
  seeded in: add a **label** and **date & time** for each FOMC decision, CPI release,
  jobs report, or other scheduled catalyst you want the loop to sit out around, sourced
  from the Fed's/BLS's own published calendars. Remove an entry once it's no longer
  relevant — there's no automatic cleanup.
- **Research, Screen & Decide** — **Run screen** scans your universe (the same
  500+-symbol S&P 500 list managed from the **Screener** page — see **Manage
  universe** there — plus Webull's pre-market "unusual volume" and gainers movers,
  when Webull is configured) for volatility/volume-breakout candidates, reusing the
  same scoring engine as the Screener page. Real-estate exclusion runs *before*
  scoring, so an excluded symbol
  never shows up as a candidate. Results split into **Candidates** (passed screening,
  now with an **Entry / Stop / Target / R** trade plan for each — the stop is set at
  1.5× the symbol's own ATR so it adapts to its actual volatility, and the target is a
  fixed 2:1 reward:risk multiple of that stop distance, not a number tuned to hit any
  particular return — note this is the *screener's* plan; when auto-trading takes one
  of these it re-places both exits against support/resistance **and against how far the
  stock actually travels in a day**, so the live target is routinely nearer — and a
  lower R — than the 2:1 shown here. A setup whose reachable target no longer pays for
  its risk is refused outright rather than entered with a limit it cannot reach), **Excluded** (real estate), **Skipped** (sector/industry couldn't
  be verified this run — reconsidered next run, never silently allowed through), and
  **Errors**. A candidate with no usable volatility history (ATR) gets no trade plan —
  shown separately as "no signal," not guessed at. Each candidate with a trade plan is
  then sized (by the configured risk-per-trade %, cut by the configured step-down %
  once your losing streak reaches its configured trigger count) and risk-checked
  against every cap — daily drawdown halt,
  concurrent-position count, the aggregate open-risk check (sum of size × stop distance
  across everything open plus this trade — distinct from the daily halt, since it
  catches several positions getting stopped out together before that halt could even
  fire), statistical-correlation exposure to other open positions, and the daily trade
  count — showing a **Qty** and an **approved/blocked** badge (with the failing rule)
  per candidate. Candidates are risk-checked in score order against a running total, so
  a batch of signals that would each pass alone can still correctly exhaust a shared cap
  (e.g. the position-count cap) partway through. This is read-only: running a screen
  never places an order. Each equity candidate's own **Dir** badge shows which side it
  resolved to (`long`/`short`) — only ever mixed within one run's results when **Trade
  direction** (Configuration, above) is set to `Both`. An **Options** column shows a
  matching options trade alongside the equity one — a long call for a long candidate,
  or a long put for a short one, on the same underlying, picked from its option chain's
  nearest expiration
  7–60 days out. Only candidates from your **universe list** are considered for options
  (not Webull's premarket movers/gainers, which surface a different set of small-caps most
  days and so can't build the real IV-rank history below) — equity signals still cover the
  full candidate set either way. A candidate needs 15 real days of its own implied-vol
  history to be ranked against that real history; short of that, it falls back to a
  realized-volatility estimate (labeled as such in the signal's rationale) — the same
  proxy the Options page's own IV panel already uses — and only skips entirely, into the
  **No options signal** list below the table, if neither is available yet. When the
  **options strategy** (Configuration, above) is set to
  `Debit spread` instead of the default `Single leg`, the column shows both strikes
  (long/short) and the net debit paid instead of a single strike and premium — the short
  leg is picked from the same chain, further out-of-the-money than the long leg, so the
  trade caps both max loss and max gain instead of just max loss. Under `Auto (by IV
  rank)`, different rows in the same table can show either shape — each candidate's own
  IV rank at signal time decides its shape, so a high-IV-rank name and a low-IV-rank name
  in the same screen can resolve differently; hover a row's rationale to see which way it
  went and why. Each options signal is
  also risk-checked — a single leg sized against the **disaster stop** (the deepest
  premium loss the exit ladder will hold a position through, **Options disaster stop
  (%)** below; contracts × $100 × that fraction), a debit spread sized by max loss per
  spread instead — against the same configured risk caps, showing an
  **approved/blocked** badge and the sized contract (or spread) count right below its
  contract details. This draws from **one combined risk budget** shared with the
  equity signals in the same run, not a separate options-only pool: an approved equity
  trade's risk counts against an options candidate's cap in the same screen, and vice
  versa. This manual preview never places an order, for either instrument type — that's
  true of **Run screen** generally, not specific to options. The automated background
  loop is the separate path that can act on an approved options signal (paper only — see
  **Paper trading** below) — single leg or debit spread, whichever the **Options
  strategy** setting below builds; both are decided and risk-checked against the same
  combined budget and, once approved, opened as a paper position the same way. Running a
  screen here also accrues IV history in the background, a day at a time, for whatever
  gets screened, regardless of whether the loop itself is enabled.
- **Backtest & walk-forward** — the validation gate every strategy configuration has to
  clear before it's allowed anywhere near a paper or live order. Give it a symbol list,
  a date range, a starting equity, a max-concurrent-positions cap, a **backtest trade
  direction** (`Long`/`Short`/`Both` — own value, independent of Configuration's own
  **Trade direction** above, same self-contained-hypothesis reasoning as the risk profile
  field next to it; in `Both`, each candidate is scored as long and short and the run
  trades whichever side qualifies, and the options engines below derive each trade's
  call/put from that same per-candidate resolved side, exactly like the live loop's
  Options column does), and (independently of
  the Configuration card above, same as the other three) a risk profile, and it replays
  Screen → Decision → Risk Check day by day over
  historical daily bars — the exact same logic the live loop above uses, so a backtest
  can't tell you something the live system wouldn't actually do. Leave **Out-of-sample
  split** blank for a single-window run, or set it to split the range into an
  **in-sample** window (what the configuration was "tuned" on) and an **out-of-sample**
  window (unseen data) — a strategy that only performs in-sample is exactly what this
  split is meant to expose. Each run shows a stat grid (trades, win rate, expectancy,
  profit factor, average R, return, max drawdown, win/loss streaks), an equity curve,
  and the full trade-by-trade list. A walk-forward run (in-sample/out-of-sample split
  set) additionally shows a **significance** panel per window — a 95% confidence
  interval on expectancy (bootstrap resampling: the range of average $/trade you'd
  plausibly see if this same window played out again) and a p-value against "no real
  edge" (a sign-flip permutation test — the fraction of random win/loss re-signings
  that produce a mean at least this extreme; conventionally, under 0.05 reads as
  unlikely to be noise). A thin trade count (under 20) is flagged rather than hidden,
  since a CI or p-value from only a few trades is itself too noisy to lean on hard.
  Like the rest of this tool, it renders no pass/fail verdict — reviewing in-sample vs.
  out-of-sample, and weighing the significance numbers alongside everything else, is
  yours to do, same as the eventual live-trading flag. At most 50 symbols per run and a
  3-year maximum date span; if one symbol's historical data can't be fetched (bad ticker,
  provider rate limit), it's called out separately and excluded — the rest of the run
  still completes.
  **Run options backtest** / **Run options walk-forward** replays the identical
  symbols/dates/profile/equity through the options overlay instead — single leg or debit
  spread, whichever the **Options strategy** setting above is set to, gated by the same
  equity screen and risk caps — a separate, independent run shown below the equity
  results, not combined with it. Under `Auto (by IV rank)`, the backtest resolves each
  day's shape the same way live/paper does — from that candidate's own IV rank on that
  historical day — so the trade list can mix both shapes across the run, exactly
  reflecting what the loop would actually have built. A spread's short leg is found the same way the live loop
  finds one (nearest contract further out-of-the-money whose delta clears the confirmed
  band), and its trade row shows both strikes with Entry/Exit $ as the spread's net value
  (long leg minus short leg). IV rank here falls back to the same realized-volatility
  estimate the human Options page already uses, and open interest/bid-ask spread can't be
  backtested at all (no historical feed exists at any data tier) — both are still fully
  enforced once a real order is ever on the table, just not checkable against history.
  Its own walk-forward run shows the identical significance panel (CI + p-value on
  expectancy) per window, described above.
  **Run combined backtest** / **Run combined walk-forward** replays the same window a
  third way: equity and options share
  ONE risk budget for real, the same way the live paper-execution loop already combines
  them — an approved equity position's risk counts against an options candidate's cap
  that same day, and vice versa, so a correlated pair of trades that would jointly
  breach a cap gets caught here too, not just independently underestimated by the two
  overlays above. Shows one stat grid and equity curve for the whole account, with the
  equity and options trade lists underneath it — and, for a walk-forward run, one
  significance panel per window computed over both books together (the same
  concatenated trade list the stat grid itself uses), not two separate ones to weigh by
  hand. Additive — the two independent overlays
  above are unchanged and still available side by side.
  **Parameter sweep — risk per trade**, below the equity walk-forward results, reruns
  that identical walk-forward split (same symbols/dates/profile/equity/max
  positions/direction) once per nearby **risk per trade %** — half to 1.5x whatever
  center value you enter — and lays each value's out-of-sample stats and significance
  side by side in one table, the base (center) value's row marked. A real edge tends to
  hold up across nearby settings; one value spiking while its neighbors look ordinary or
  negative is the classic sign of a lucky overfit on that exact number rather than a
  genuine edge (see the Strategy Playbook's own section on this). Needs an out-of-sample
  split date set above — there's nothing to compare a sweep against otherwise. Client-side
  only (five walk-forward calls in sequence, not a new server endpoint) and read-only,
  same as everything else in this card.
- **Paper trading** — the execution loop itself. When **Auto-trading enabled** is checked
  above, the server runs Screen → Decision → Risk Check → Execution on its own every
  minute; **Run one cycle now** runs the exact same cycle immediately, so you can watch
  it work without waiting. Every fill is a local simulation from a live quote — it never
  places a real order. No new entries in the first/last 15 minutes of the session, and a
  volatility filter (the candidate's own ATR%, plus a broad-market proxy) can skip a
  cycle's entries entirely; open positions are still checked for a stop/target hit
  either way. Shows open/closed counts, realized P&L, unrealized P&L, and the full paper
  trade history (side, entry, a live **Current $** for open positions, exit, reason,
  P&L, R). An open position's P&L and R come from a live quote fetched fresh on every
  load/refresh — the same resolution the human Positions page uses, including its
  last-known-price fallback (flagged with an amber "stale" chip) if a live quote can't
  be fetched right now. Concurrent-position and aggregate-open-risk caps here are scoped
  to the loop's own paper positions, not your real ones on the **Positions**/**Journal**
  pages — paper trades carry no real financial exposure, so they're evaluated
  independently, the same way a real paper-trading account would be.
  **Options paper positions**, right below, mirrors the same idea for the options
  overlay — long calls/puts or debit spreads (whichever the **Options strategy** setting
  is building), sized and risk-checked against the exact same combined budget as equity
  above: an approved equity fill counts against the next options candidate's cap, and
  vice versa, for the real running loop now, not just the preview risk-check. A spread
  fills and closes both legs together — its Contract column shows both strikes
  (`long/short`), and Entry/Current/Exit $ show the spread's net value (long leg minus
  short leg), not a single premium. Automated exits here are time-based (closing a
  position as expiration approaches, matching "never hold an option through expiration")
  plus optional price-based **stop-loss** and **take-profit** — % of premium paid (net
  debit for a spread), set via **Options stop-loss (%)** / **Options take-profit (%)** in
  Configuration; each defaults to 0 (disabled). Delta-drift still stays
  human-review-only on the Options page. The exit-reason badge is color-coded (green
  take-profit, red stop-loss, blue time-exit, slate end-of-period) in both this table and
  the options backtest results below. These two price rules apply to **live**
  options as well (since 2026-07-26 — see "Live options trading" above), unlike
  the equity trailing-stop/breakeven fields below, which are still paper and
  backtest only. Shows the same
  open/closed counts, realized/unrealized P&L, and full trade history (contract,
  strike/expiration, entry, a live **Current $** for open positions from a fresh
  contract quote, exit, reason, contracts, P&L, R) as equity's own paper trading above.
  A debit spread's **short leg** — the only leg this app ever writes short; a
  single-leg position is always a long call/put — gets a passive **Assignment risk**
  chip on its Contract cell, in both this table and its live-options counterpart,
  once it's deep in-the-money with essentially no time value left (≤ $0.05/share of
  extrinsic value), the point where the holder loses nothing by exercising early. A
  short **call** specifically shows a **Div. assignment risk** variant instead when
  the underlying's ex-dividend date is within 5 days — the classic dividend-capture
  early-exercise case (a put's early-exercise driver is interest rates, a different
  mechanism not modeled here). Display-only, like the earnings badge above — it
  doesn't change sizing, exits, or entries; roll or close the spread yourself if you
  want to avoid it.
- **Recent activity** — a journal of what the screen, decision, and risk-check stages
  did and why (candidate found, excluded, signal generated, passed/blocked, a paper
  order placed or closed, a setting changed) — the same feed the execution loop above
  writes into automatically.

This is decision-support and tracking, not financial advice — check the spec doc for the
full design, current status, and the roadmap for the options-trading addition still to
come.

---

## Settings

One home (⚙ or `⌘K → Settings`) for everything:

- **Market data provider** — read-only status + capabilities, with a *Details & test*
  button. (The provider itself is configured server-side in `server/.env`.)
- **Risk & sizing defaults** — your **account size** and **default risk %**, shared by
  the position sizer and the benchmark.
- **Discipline guardrails** — an opt-in **daily loss limit ($)** and **max new trades
  per day**. When today's booked loss or trade count reaches a limit, the **Today**
  dashboard warns you to step away. `0` = off; it never blocks or places trades.
- **Benchmark** — the index symbol the Journal measures you against (default `SPY`).
- **Pre-trade checklist** — the canonical editor for your discipline rules (saved
  server-side).
- **Alerts** — the background auto-check interval, and an opt-in toggle for **desktop
  notifications** when an alert fires (while the tab is in the background).
- **Server-side watching** — enable the **background poller** (server-side, runs with the
  app closed) and its interval, see whether a **webhook** is configured, and send a test.
- **Webull (beta)** — shows whether Webull OpenAPI credentials are configured
  (`WEBULL_APP_KEY` / `WEBULL_APP_SECRET`, server-side) and runs a read-only **connection
  test**: account list, stock snapshot, stock candles, market movers, positions, balance,
  or **quote subscriptions**.
  Webull's v2 OpenAPI provides stock **and option** market data plus your account (market
  data needs an active OpenAPI subscription). If a snapshot is refused with _“Insufficient
  permission, please subscribe to stock quotes”_, run the **quote subscriptions** check — it
  lists what Webull's OpenAPI actually sees for your app, so you can tell an OpenAPI quote
  plan apart from a mobile-app / desktop (QT) plan, which don't grant API access.
  A **stock instrument (unconfirmed)** check is also available — its response shape has
  never been confirmed against a real account, so run it yourself to see what it actually
  returns (e.g. whether it carries a shortable/hard-to-borrow flag) before anything reads it.
- **Account** — only shown when the app is password-protected (`APP_PASSWORD` set
  server-side). Turn on **two-factor authentication** (an authenticator-app code at
  login — scan/enter the setup key, confirm a code), disable it (needs a current code),
  and **Sign out** to end your session on this browser.
- **Data** — export / backup / restore.

> **Password protection (optional).** If the server sets `APP_PASSWORD`, the app shows a
> **login** before any data loads — use this when hosting on a public URL. It's one shared
> password (no usernames). You can add **two-factor** (an authenticator-app code) from
> **Settings → Account**; if you lose your authenticator, set `DISABLE_MFA=true` on the
> server to recover. Repeated failed logins lock new attempts out briefly (30s, doubling
> with continued failures — an existing session keeps working), and each authenticator
> code works **once**: two protected actions inside the same 30-second code window (e.g.
> logging in and then disabling two-factor) each need their own code, so wait for the
> next one. See the README and the [Deployment guide](DEPLOY.md).

---

## A recommended daily workflow

1. **Open Today.** Clear the *Needs attention* panel first — act on any stop/target/
   exit-rule hits and triggered alerts. Then scan **Upcoming catalysts** (earnings/ex-div
   within 14 days across your positions and watchlist) and **Upcoming expirations**
   (option DTE, plus an **assignment risk** badge on any short position that's deep ITM
   with little time value left) — the two-minute "what could surprise me today" check
   before you plan anything else.
2. **Get your shortlist.** The fastest path at the open is **Today's setups** on the
   dashboard (one **Scan**). For the full controls, open the **Screener** (long and/or
   short), expand the top names, and sanity-check the breakdown. **Save a snapshot** so
   you can measure this run's edge later.
3. **Plan entries.** For each candidate, decide an **entry, stop, and target** *before*
   you commit. Use **Size by risk** so every trade risks the same small % (your "1R").
4. **Run the pre-trade checklist** and **log the trade** with tags + grade. Set the
   stop/target so exit alerts watch it for you.
5. **For options**, use **Entry scan** to pick a liquid contract in your delta band,
   mindful of **IV rank**; set **Exit rules** (TP/SL/time).
6. **During the session**, let alerts/Today tell you when to act. Watch each open
   trade's **R** on the management line.
7. **After the close**, record exits, then visit the **Journal**: update the equity
   curve, check **by-tag/by-grade/by-discipline**, and glance at **drawdown** and
   **risk of ruin**.
8. **Weekly**, review the **Edge Report** (are your top picks outperforming?), your
   **MAE/MFE** (are stops/targets well placed?), and your **alpha vs SPY** (is active
   trading worth it?). Prune setups and rules that don't earn their keep.

---

## Data, privacy & providers

- **Your data stays with you.** Positions, journal, presets, and settings live in a
  **local SQLite database** on the machine running the server. API keys are
  **server-side only** and never reach the browser.
- **Provider options.** Free **Yahoo** (stocks + option chains, no key), **Tradier**
  (brokerage data), **Webull** (`MARKET_DATA_PROVIDER=webull`), or the keyless **mock**.
  Webull is a **composite**: real-time US **stock** quotes + candles come from Webull's
  licensed feed, while **option chains** come from Yahoo (Webull's OpenAPI has no
  option-chain endpoint). **Fundamentals** blend Webull's snapshot valuation metrics
  (market cap, P/E, EPS, 52-week) with Yahoo's company profile. Stocks Webull doesn't
  carry (e.g. class shares like BRK.B) fall back to Yahoo automatically. Webull stock data needs an active OpenAPI
  quote subscription on your account.
- **Sync positions from Webull.** In **Settings → Webull**, preview your open Webull
  positions and import the ones not already in your journal (preview-and-confirm; import
  only *adds* — it never edits or deletes existing entries, and tags imports `webull`).
  This is where your **manually-opened Webull positions — stocks *and* options — appear**:
  they show on the **Positions**/**Journal** pages once imported. (The Auto-Trade page's
  **Live options positions** table is a different thing — it lists only options the *bot*
  itself placed, never ones you opened yourself in the Webull app, so don't expect a manual
  option to show there.) **Single-leg options** — long calls/puts — import correctly: Webull
  returns each as a strategy container with the contract nested in a `legs` array (strike
  under `option_exercise_price`), and the importer reads that shape. **Multi-leg strategies
  (spreads)** are the one case still left out, on purpose: the journal is one contract per
  row and Webull's payload gives no per-leg buy/sell side to split a spread correctly, so a
  spread is skipped rather than imported wrong. If any option *doesn't* import, the
  **Preview** tells you why — it counts how many payload rows **looked like an option but
  couldn't be parsed** ("N of them option-like") and lists their field names; check the **raw
  payload** to confirm (and send those field names along if a shape still isn't recognized).
  If they're not in the raw payload at all, Webull's positions endpoint isn't returning
  options for your account, and there's nothing to import.
  **Sync now** and the **automatic background sync** below it go further, in two ways:
  - They **reconcile orders this app already placed** — including a bracket's stop-loss/
    take-profit exit leg, which used to be missed by "Refresh status"/"Refresh all" once the
    entry itself had filled (a bracket's own status only ever reflects its entry leg).
  - They **close journal positions Webull no longer shows as held at all** (e.g. sold
    directly in the Webull app) — for anything still not attributable to a known order.

  Either way, Positions/Journal (and the Auto-Trade page, for `live`-tagged positions)
  previously kept showing a position as open long after it was actually sold. When the exit
  price comes from the close-detection side (no fill to read a price from), it's an
  *estimate* from the latest quote, noted as such on the exit — edit it if you have your
  broker confirmation. List your account IDs once under **Auto-sync accounts**, flip on
  **Sync automatically in the background**, and pick an interval (1m–30m); it then keeps
  itself current with no further clicking, independent of any open tab. If you trade **more
  than one real account** (e.g. a cash account *and* a margin account), put **all** of them
  in that comma-separated field — the background sync reconciles every account each tick, so
  a position sold in one account no longer sits open just because a different account was the
  one being synced. (The single **Account ID** field above it is separate — it's only for the
  one-account-at-a-time **Preview**/**Sync now**/**Compare** buttons; a **+ Add** shortcut
  copies it into the auto-sync list.) Every broker-truth close or quantity correction a
  sync makes (equity or options) also shows up as its own **Recent activity** entry on the
  Auto-Trade page — visible the moment it happens, not just discoverable later from a wrong
  P&L number.
  >
  > **Compare against broker (2026-07-18).** Next to Preview/Sync now is a **Compare against
  > broker** button — a read-only, on-demand snapshot listing every contract the broker
  > currently shows held for that account side-by-side with what the journal shows open,
  > flagging any mismatch. Unlike a sync, it writes nothing and reports *everything*,
  > matches included, so drift is visible the moment you check rather than only inferable
  > later from the P&L or open quantity looking wrong.
  >
  > **Multiple real accounts (2026-07-17).** Every synced position (and every live position
  > the Auto-Trade page itself opens) now remembers which Webull account it actually came
  > from. If you trade more than one real account — e.g. a cash account and a margin
  > account — switching the account ID here (or in Auto-Trade's live-trading settings) no
  > longer touches the OTHER account's positions: each sync only ever closes or matches
  > against lots tagged with that same account. Before this fix, switching accounts could
  > wrongly mark the previous account's still-open positions as closed, and could silently
  > merge a new buy in the new account into an existing position from the old one instead of
  > tracking it separately. If you were affected before upgrading, see a wrongly-closed
  > position's **journal** dialog above to remove the bad exit and reopen it, then set its
  > correct account there too, before re-syncing.
  >
  > **Flapping-close protection (2026-07-17).** A single sync that doesn't show a position
  > held at the broker no longer closes it by itself — a momentarily incomplete/flaky
  > response from Webull used to be enough to trigger a close on the spot, and the very next
  > sync would then re-import the still-genuinely-held position as a brand-new one, repeating
  > indefinitely and booking a fabricated exit (and P/L) each time. A close now only happens
  > once the same position has been missing on **two consecutive syncs** with nothing in
  > between confirming it's still held — a real sell is still caught within a sync interval
  > or two, but one bad response can no longer fabricate a close/reopen cycle. If your journal
  > or P/L already looks inflated with repeating same-symbol entries from before this fix,
  > see **Settings → Data** below to export, review, and clean up affected rows.
  >
  > **Self-heal for legacy unassigned rows + stuck-close visibility (2026-07-23).** Two gaps
  > that could leave a *sold* position showing open forever are now handled:
  > - A **legacy row with no account recorded** (imported before per-account tracking, or
  >   manually tagged `webull`) that was already sold *before* any sync claimed it never got
  >   closed, because the account-scoped close pass conservatively skips rows it can't attribute
  >   to the synced account. It now **closes and claims** such a row automatically — but *only*
  >   when the journal has never recorded any **other** account (a single-account setup, where an
  >   unassigned row can only belong to the one account being synced). The moment a second account
  >   exists, unassigned rows are left strictly alone again (surfaced via **Compare against broker**
  >   instead), preserving the cross-account protection above.
  > - A position confirmed sold at the broker but which **can't be priced** right now (an illiquid
  >   or delisted contract the quote resolver can't reach) is still left open to retry — but now logs
  >   a one-time **`position_reconcile_skipped`** entry on **Recent activity** so it's visible rather
  >   than silently never closing. If a position stays stuck this way, close it manually from the
  >   Positions page. If instead a sold position is stuck because it's tagged to a **different/older
  >   account ID** than the one you now sync (e.g. you re-entered the ID), that stays deliberately
  >   untouched — run **Compare against broker** to confirm, then close it from its **journal** dialog
  >   (or re-import under the current account to re-stamp it) rather than have the app guess.
  >
  > **A sync that stops working now says so, and bad payloads can't fabricate closes (2026-07-28).**
  > Fixes for ways the journal could silently drift from (or be corrupted against) the broker:
  > - The **background scheduler logs its own failures**: when an account's sync starts
  >   failing (an expired token, Webull down), a one-time **`webull_sync_failed`** entry
  >   appears on the Auto-Trade page's **Recent activity** — and a **`webull_sync_recovered`**
  >   entry when it works again. Before, a dead background sync looked exactly like "nothing
  >   to sync": no closes, no imports, and the only trace on a server console nobody reads.
  > - A positions payload in a **shape the app doesn't recognize** is reported as an error
  >   (check the raw payload via **Preview**) instead of being read as an *empty account* —
  >   which the close-detector would otherwise treat as "everything here has been sold" and,
  >   after the two-sync debounce, close the whole journal at fabricated prices.
  > - A payload **row that fails to parse** (e.g. a multi-leg spread container, which the
  >   importer deliberately skips) still proves the broker holds *something* in that symbol —
  >   so that symbol's positions are exempt from close-detection for that sync, rather than
  >   counting as "missing" and getting auto-closed while still held. The concrete case: a
  >   tracked single-leg option you later leg into a spread.
  > - The **expired-option case** — the sync could never price a broker-dropped expired
  >   contract and left it open forever — is fixed too; see the expired-options section of
  >   [Positions](#positions--pl) above.
- **Quotes may be delayed** (commonly ~15 min on free tiers). The provider chip shows
  live vs demo. Responses are cached briefly and pages with a **Refresh** control
  auto-poll every **1 minute** by default (adjustable, including off).
- **Demo/synthetic data** is deterministic placeholder data for trying the app — it is
  clearly labeled and must **not** be used for real decisions.

---

> ⚠️ **Disclaimer.** This tool is for personal research and education. It is **not
> financial, investment, or trading advice**, and nothing in it is a recommendation to
> buy or sell anything. No guarantee of accuracy or performance; past results never
> guarantee future outcomes. Trading stocks and options carries substantial risk of
> loss. You are solely responsible for your decisions. The app does not connect to a
> broker and does not place orders.
