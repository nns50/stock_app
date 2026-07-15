# User Guide

A practical, page-by-page guide to using **stock-app** — your personal day-trading
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

- **Collapsible tiles:** every section below — **Today's setups**, **Market movers**,
  **Needs attention**, **Watchlist**, **Upcoming expirations**, and **Latest screener
  snapshot** — collapses independently (see "The interface" above).
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
- **Needs attention** panel — positions that hit their stop/target or option exit
  rules, plus any triggered symbol alerts, each linking to where you act.
- **Watchlist** mini-view with last price and % change.
- **Upcoming expirations** — your open option positions sorted by days-to-expiry (≤ 7
  days turns amber).
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

Filters (price, average volume, RSI band, trend alignment) are applied **separately**
from scoring. A symbol can score well yet be flagged as *not passing* your filters,
with the reasons shown. Toggle **"Include filtered-out (full breakdown)"** to see
everything, including why each was excluded.

### Direction, presets & config

- Switch between **long** and **short** — the scoring mirrors itself.
- All weights, periods, and scales are **editable**, and you can **save presets** to
  reuse a configuration.

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
**breakevens**, **max profit/loss**, **combined Greeks**, and a lognormal
**probability-of-profit (POP)**. Use it to compare structures (e.g. a debit spread vs a
naked long call) on risk-defined terms.

Once you've built a single leg or a 2-leg vertical, **Trade this structure →** hands it to the
**Trade** page — it prefills the order builder with the strategy and each leg's buy/sell, call/put,
and strike. The analyzer carries no symbol or expiry, so you set those (the chain picker fills real
strikes); other structures (straddles, iron condors) aren't live-placeable yet.

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
  limit price). Options support every type **except market**.
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
  Extended/Overnight don't trigger it.
- **Place order** — appears only when a live preview **would submit**. Type the shown phrase
  (e.g. `BUY 1 NUVB`) to arm, then place. The **server** re-pulls your account, re-runs every
  guardrail, checks the kill switch + `TRADING_ENABLED`, and writes the intent + broker
  `order_id` to the audit trail. One order at a time — stock, or a **single-leg option**
  (call/put + strike + expiry; limit or stop types — Webull has no market options).
- **Orders** — recent intents (placed + dry-run), newest first, with their lifecycle state. A
  multi-leg or bracketed order carries a small **strategy tag** (`vertical` / `covered` / `condor` /
  `bracket`) so the row explains itself. For an order that reached the broker, **Refresh status**
  pulls the live broker status by your order id and advances the intent to **filled / partially
  filled / cancelled / expired** (writing the fill price into the audit trail). Single-leg/stock fills
  also flow into the **Positions ledger**: an **open** fill is **auto-recorded as a Position**, and a
  **close** fill **records an exit** against the matching open position(s) — oldest lot first (FIFO),
  a sell-to-close reducing a long and a buy-to-close a short — so the Journal's realized P&L tracks
  live trades automatically. (Spreads aren't auto-tracked — their single-leg fields are null.)
  **Cancel** appears on an order that's still working
  (acknowledged / partially filled): it requests a broker cancel, then reconciles to show the
  result. Cancel is risk-reducing, so it works even when `TRADING_ENABLED` is off. **Modify**
  changes a working order's **quantity / limit price** in place (Webull "replace"); because a
  modify can _increase_ exposure it's gated like placing — `TRADING_ENABLED` plus the guardrails
  re-run against the new values — then reconciled. Modify is offered only for a **single-leg**
  order (stock or single option): a spread or a bracket is one _combo_ of broker orders, so the
  in-place replace can't safely retune it — change it by **Cancel**-and-re-place instead (the
  server refuses a spread/bracket modify for the same reason).

### Guardrail config

The side panel persists your safety settings (server-side):

- **Kill switch** — a one-click sticky halt; while engaged, every dry-run is blocked.
- **Trading enabled** — the in-app arming switch (the `trading_enabled` guardrail). This is
  **separate from** the server env `TRADING_ENABLED`: the env var gates the whole deployment,
  while this checkbox arms placement at runtime. **Both must be on** to place — setting the env
  var alone still leaves `trading_enabled` ✕ in the preview until you check this and **Save**.
- **Allow naked short**, and the caps: **max order $**, **max symbol qty**, **max exposure $**,
  **max orders/day** (counts only orders that reached the market — broker-rejected orders don't
  burn a slot), **max daily loss $**, **fat-finger %**.

Defaults are intentionally tiny and trading ships **off**. The rules: per-order notional,
buying power (buys only), exposure ceiling (opening adds, closing doesn't), per-symbol size,
daily-loss halt, max orders/day, fat-finger price sanity, naked-short block, a spreads-need-margin
check (cash/IRA accounts can't trade spreads), limit/stop price
presence, a session/order-type check (extended & overnight sessions are limit-only), an
options-have-no-market-order check, and the enabled/kill-switch gates — anything that can't be
verified **fails closed**.

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
- **exit** records a (partial or full) exit; **journal** edits tags/grade/notes;
  **del** removes it (with confirm + Undo).
- An **Exposure panel** summarizes gross/net exposure across the book.

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

### Breakdowns

- **By tag**, **by grade**, **by discipline** (checklist adherence), and **by timing**
  (which **weekday** you closed on, how long you **held**, and — for trades with a logged
  entry time — the **entry session**: open / late-AM / midday / power hour) — each with
  its own count, total, win rate, and expectancy. This is how you discover *which
  setups and which behaviors* make you money.

### Curves & risk

Equity curve, edge over time, and drawdown & streaks are shown directly on the page.
**Risk of ruin**, **Excursions**, and **Execution quality** are three tabs of one
**Analytics** button (top right) — pick a tab, the report loads on demand.

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
- **Excursions (MAE/MFE)** — for closed *stock* trades, replays daily candles over the
  holding period to show **Maximum Adverse Excursion** (how far underwater it went) and
  **Maximum Favorable Excursion** (how far in profit), in **%** and **R**. Use it to
  tighten stops and set realistic targets.
- **Execution quality (slippage)** — for each **live-traded** entry/exit that came from an
  order with a limit price, compares the actual **broker fill** to the **limit you set**.
  Positive $ always means it cost you money, whichever side you were on (a buy filled
  above your limit, or a sell filled below it); sorted worst-first. Only live fills placed
  through the app's Trade builder count — a pure stop-market fill has no limit to compare
  against, and a manually logged or imported trade was never a live order at all, so
  neither is included. A consistent positive bias points at marketable limits or wide
  spreads at entry/exit.

### Benchmark

- **You vs SPY (buy & hold)** — your realized return over the trading window vs simply
  holding the index, and your **alpha**. Alpha < 0 means buy-and-hold would have beaten
  your active trading over that period — a humbling, essential reality check. The
  benchmark symbol is configurable in **Settings**.

### Data tools

- **Export** CSV or JSON, take a full **`.db` backup**, or **import** a positions
  export (append or replace). Great for backups and moving between machines.
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

- **Configuration** — a master **enabled** switch for the execution loop below (when on,
  the server runs the full cycle on its own every minute, placing paper trades — see
  "Paper trading" below), the active **risk profile** (`Moderate`, the conservative
  default, or `Aggressive`) — today this is just a label, journaled with every trade so
  your history shows which posture you intended; it no longer changes any guardrail
  number itself (see below — every one is its own directly-editable field now).
  Switching to Aggressive still always pops a confirmation dialog, since flipping the
  label that's baked into your trade journal should be a deliberate choice, not a
  default, never a silent dropdown change. Next to it, the **options strategy** the
  loop builds (`Single leg` — a long call/put, uncapped upside, the default — or
  `Debit spread` — the same long leg plus a further out-of-the-money short leg that
  caps both max loss and max gain; switch anytime, no confirmation needed), and
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
  threshold (|r|)** fields right below it), and **max trades per day** (a hard cap on
  new entries, paper and live, stocks and options, all combined). Every field here
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
  times its own average to pass the screener), **max ticker ATR** and **max market
  ATR** (skip a candidate whose own volatility is too high, or skip every new entry
  this cycle if SPY's own volatility is too high — stricter than the manual Screen/
  Decision preview below, since an unattended loop has no one to override a bad read),
  **stop distance** and **target** (the stop sits this many ATRs from entry; the target
  sits stop-distance × this further out, as a reward:risk multiple), **session
  buffer** (no new entries within this many minutes of the open or close, when prices
  are most distorted), and **earnings blackout** (skip an equity candidate whose next
  known earnings date falls within this many calendar days — an unattended loop can't
  react to an earnings-driven overnight gap the way ATR-based stop sizing assumes;
  options entries are unaffected, since an approaching print already shows up as
  elevated IV rank there instead). All eight default to the values the loop always
  used before they were configurable (trade direction to `Long`; earnings blackout's
  own "before" is simply never checking — 0 disables it), so leaving them untouched
  changes nothing; the manual
  Screen/Decision preview
  below defaults to these same saved values too (so it previews what the loop would
  actually do), though it has no UI to override them ad hoc today. A related but
  separate **max hold time (days)** setting forces a position closed at the day's price
  after it's been open this many calendar days without its stop or target firing — a
  backstop against a position that's just drifting sideways forever. Defaults to
  **0 (disabled)**, so leaving it untouched changes nothing; unlike the eight fields
  above, it has no manual-preview equivalent — there's nothing to preview about how
  long a position stays open before it's even entered. Five more fields manage an
  already-open **paper or backtest** equity position the same way a discretionary
  trader might (**live positions are untouched — still a fixed stop/target for
  life**): **breakeven trigger** (once unrealized gain reaches this many R, move the
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
  **Auto-promote recurring movers** (on by default) grows your universe automatically:
  a symbol Webull's premarket movers surface that also clears screening on **3 distinct
  days within a 10-day window** (both tunable, along with a **50-symbol lifetime cap** on
  how many this can add) earns a permanent spot in your universe — the same list the
  **Screener** page's **Manage universe** edits — so a genuinely active name stops being
  re-discovered and re-scored from scratch every day. Only ever runs from the background
  loop, never from a manual **Run screen**; each promotion shows up in **Recent
  activity**, and once added, a symbol you later remove is never re-added by this
  mechanism. The **kill switch** button above these settings is a separate, sticky
  emergency halt —
  engaging it (one click, no confirmation needed, mirroring the same button on the
  **Trade** page) blocks all new entries immediately, regardless of the enabled toggle
  or session window, but does **not** close your existing paper positions — their
  stop/target levels keep being checked every cycle, exactly as if you'd left the loop
  running. Releasing it resumes the loop automatically if **enabled** is still checked;
  it doesn't touch that setting either way.
- **Live trading** — configure and arm the loop to place **real** orders through Webull.
  Set a **Webull account ID** (server-side only — unlike the Trade page, never sourced
  from your browser) and the **live guardrail caps**: max order size ($), max daily loss
  ($), max orders/day, fat-finger %, and whether to **allow naked-short exposure**
  (leave unchecked unless **Trade direction** above is `Short` or `Both` — every other
  position this app can take live is defined-risk (long stock, long calls, long puts),
  so this stays off by default; check it only once you've deliberately decided you want
  the loop opening real, uncapped-downside equity shorts, not just paper-trading them).
  **Suggest from
  equity** fills the first three of those from your account equity and the configured
  daily-drawdown %/max-trades-per-day (25% of equity for the order cap, matching those
  two settings exactly for the other two) — a starting point only, so it fills the
  fields without saving them; review or edit before clicking **Save live-trading
  settings** below. Needs account equity set first (Configuration, above). A **probation**
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
  A **Live positions** table below shows every real position the loop has actually
  placed — the exact same `positions` rows your own manual trades use on the
  **Positions**/**Journal** pages, filtered here to just autotrade's own fills (tagged
  server-side, not a separate table the way paper trading is). Shows the same open/closed
  counts and realized/unrealized P&L stat tiles as the paper tables, plus each position's
  live price/mark, quantity (showing the remaining fraction once partially closed), P&L,
  and R-multiple — stock and option positions both render here, with option contract
  details (strike/type/expiration) shown inline. This is the dedicated place to see your
  real autotrade fills at a glance; they also appear, unmarked, mixed in with your manual
  trades on the Positions/Journal pages and the Trade page's Orders panel. Kept accurate
  every cycle by a broker-truth check (diffs against what Webull actually shows open) as
  a backstop for anything a specific order's own status doesn't catch on its own — no
  separate setup needed, unlike the general Webull position sync under Settings.
- **Live options trading** — a checkbox nested under **Live trading** above (only shown
  once live trading itself is enabled) that lets the loop place real **single-leg**
  (long call/put) and **debit-spread** options orders through Webull — no second
  confirmation phrase; the live-trading phrase above already covers "real money is now
  live." Its own dedicated **guardrail caps** (max order, max daily loss, max
  orders/day, fat-finger %) and **probation** window, separate from the equity live
  caps above, since options can go live weeks after equity and size differently
  (premium-based, not share-count-based). A single-leg entry places a plain limit
  order; a debit spread places **one** combo order for both legs together, never two
  separate orders. The automated exit is the same close-only, time-based rule paper
  options trading already uses (no price-based stop/target) — but here it places a
  **real** closing order (a single-leg sell, or both spread legs together as one combo)
  instead of just recording a paper close. A **Live options positions** table below
  the equity Live positions table shows every real options position the loop has
  placed, with the same side/strike badges (and both strikes for a spread) as the
  options paper table. Kept accurate every cycle by the same kind of broker-truth
  backstop the equity table uses — for a spread, both legs have to be confirmed gone
  at the broker before it's marked closed; one leg missing on its own is left open
  rather than guessed.
- **Alerts** — a few loop events push a notification through whichever webhooks you've
  configured in [Settings → Server-side watching](#server-side-watching-alerts-with-the-app-closed)
  (Slack/Discord/generic) — the same destinations the price-alert poller uses, so
  nothing new to set up. A **live order placed** notifies with the symbol, side,
  quantity, and limit/stop/target; **engaging** the kill switch notifies too (releasing
  it doesn't — that's the safe direction); and if **live orders keep getting rejected**
  (three in a row — a bad price, a broker/account problem, a config error, so no live
  trades are getting through), you get one alert naming the count and the latest reason,
  then at most one reminder an hour while it persists, reset the moment an order gets
  through. The **daily-drawdown halt** also notifies — paper, live, and live options
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
  check and fix that position yourself. All alerts here are best-effort: with no
  webhook configured, nothing is sent and nothing fails.
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
  very first cycle, and survives the page being closed and reopened. If that cycle
  didn't place any entries, the exact reason (kill switch engaged, market closed,
  within the session buffer, etc.) shows first, in place of the funnel. Below that, a
  real-time panel reads the loop's current state directly: active
  **risk profile**, **open positions** vs. the configured concurrent-position cap
  (Configuration's "max concurrent positions," not the risk profile — see above),
  **aggregate open risk** used vs. its $ cap, today's **day P&L** vs. the $ level that
  would trigger the daily-drawdown halt, **trades today** vs. the daily cap, and the
  **consecutive-loss streak** vs. the count that triggers step-down sizing. A
  **correlated exposure** tile is the one exception to "live gauge" above — correlation
  is relative to a specific candidate, not a single portfolio-wide number, so instead it
  shows the **last candidate actually risk-checked** against this cap: its symbol, the $
  amount already correlated, how long ago, and a red **BLOCKED** flag if that check is
  what stopped it — reading "no candidate checked yet" until the loop (or a manual **Run
  screen**) has evaluated at least one. Every other figure
  is scoped to the loop's own paper positions (never your real ones) and is a direct read
  of the same numbers the risk engine itself checks before approving a trade — this panel
  can't show you something the risk engine would disagree with. A tile goes red once
  its cap is reached; the day P&L tile specifically shows a distinct "HALT TRIGGERED"
  label (not just its ordinary red-for-a-loss coloring) once the daily-drawdown halt is
  actually breached, so an ordinary down day and a halted one are never hard to tell
  apart. **Open positions** and **aggregate open risk** fold in your open options paper
  positions too — one combined pool, not a second one, matching how the risk engine
  really enforces both caps together — with a sub-label breaking the combined number back
  out into its equity/options parts. Whenever any options paper positions are open, an
  **Options expirations** list appears below, sorted soonest-first, so you can see an
  upcoming expiration (and the automated close-only exit that's coming for it) before it
  happens — a position within a week of expiring is flagged in red. A second **Live**
  section right below shows the exact same figures for your live (equity) positions —
  its **own** pool, never combined with paper's counts or risk (they're risk-checked
  completely independently, matching how the loop actually enforces the caps), plus a
  **Probation** tile showing the size cut and trades remaining while it's active. A
  third **Live options** section mirrors it for your live options positions — its own
  pool nested under the live gate, with its own $ caps and probation tile, same
  reasoning as the equity Live section just above it.
- **Real-estate exclusion list** — real estate is a hard, permanent exclusion for this
  strategy. A starter list of well-known real-estate ETFs ships seeded in; add or remove
  symbols freely. This list is a backstop, not the only check — the screen below also
  classifies every candidate by sector/industry, so REITs and real-estate operating
  companies that aren't on the list (e.g. cell-tower or data-center REITs) still get
  caught.
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
  particular return), **Excluded** (real estate), **Skipped** (sector/industry couldn't
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
  trade caps both max loss and max gain instead of just max loss. Each options signal is
  also risk-checked — a single leg sized by full premium paid (contracts × $100, the
  option's real worst case), a debit spread sized by max loss per spread instead (there's
  no price stop for either shape) — against the same configured risk caps, showing an
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
  a date range, a starting equity, a max-concurrent-positions cap, and (independently of
  the Configuration card above, same as the other three) a risk profile, and it replays
  Screen → Decision → Risk Check day by day over
  historical daily bars — the exact same logic the live loop above uses, so a backtest
  can't tell you something the live system wouldn't actually do. One exception today:
  **trade direction** — the backtest engine can replay `Long`, `Short`, or `Both` just
  like the live loop, but this form has no control for it yet, so a run from this page
  always tests `Long`-only regardless of what **Trade direction** is set to in
  Configuration above; testing `Short` or `Both` needs a direct API request (`directionMode`
  on `POST /api/autotrade/backtest`) until a form control is added. Leave **Out-of-sample
  split** blank for a single-window run, or set it to split the range into an
  **in-sample** window (what the configuration was "tuned" on) and an **out-of-sample**
  window (unseen data) — a strategy that only performs in-sample is exactly what this
  split is meant to expose. Each run shows a stat grid (trades, win rate, expectancy,
  profit factor, average R, return, max drawdown, win/loss streaks), an equity curve,
  and the full trade-by-trade list. This tool doesn't render a pass/fail verdict —
  reviewing in-sample vs. out-of-sample and deciding whether a configuration held up is
  yours to make, same as the eventual live-trading flag. At most 50 symbols per run and a
  3-year maximum date span; if one symbol's historical data can't be fetched (bad ticker,
  provider rate limit), it's called out separately and excluded — the rest of the run
  still completes.
  **Run options backtest** / **Run options walk-forward** replays the identical
  symbols/dates/profile/equity through the options overlay instead — single leg or debit
  spread, whichever the **Options strategy** setting above is set to, gated by the same
  equity screen and risk caps — a separate, independent run shown below the equity
  results, not combined with it. A spread's short leg is found the same way the live loop
  finds one (nearest contract further out-of-the-money whose delta clears the confirmed
  band), and its trade row shows both strikes with Entry/Exit $ as the spread's net value
  (long leg minus short leg). IV rank here falls back to the same realized-volatility
  estimate the human Options page already uses, and open interest/bid-ask spread can't be
  backtested at all (no historical feed exists at any data tier) — both are still fully
  enforced once a real order is ever on the table, just not checkable against history.
  **Run combined backtest** / **Run combined walk-forward** replays the same window a
  third way: equity and options share
  ONE risk budget for real, the same way the live paper-execution loop already combines
  them — an approved equity position's risk counts against an options candidate's cap
  that same day, and vice versa, so a correlated pair of trades that would jointly
  breach a cap gets caught here too, not just independently underestimated by the two
  overlays above. Shows one stat grid and equity curve for the whole account, with the
  equity and options trade lists underneath it. Additive — the two independent overlays
  above are unchanged and still available side by side.
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
  short leg), not a single premium. The only automated exit here is time-based — closing
  a position as expiration approaches, matching "never hold an option through
  expiration" — take-profit, stop-loss, and delta-drift stay human-review-only on the
  Options page. Shows the same open/closed counts, realized/unrealized P&L, and full
  trade history (contract, strike/expiration, entry, a live **Current $** for open
  positions from a fresh contract quote, exit, reason, contracts, P&L, R) as equity's own
  paper trading above.
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
- **Account** — only shown when the app is password-protected (`APP_PASSWORD` set
  server-side). Turn on **two-factor authentication** (an authenticator-app code at
  login — scan/enter the setup key, confirm a code), disable it (needs a current code),
  and **Sign out** to end your session on this browser.
- **Data** — export / backup / restore.

> **Password protection (optional).** If the server sets `APP_PASSWORD`, the app shows a
> **login** before any data loads — use this when hosting on a public URL. It's one shared
> password (no usernames). You can add **two-factor** (an authenticator-app code) from
> **Settings → Account**; if you lose your authenticator, set `DISABLE_MFA=true` on the
> server to recover. See the README and the [Deployment guide](DEPLOY.md).

---

## A recommended daily workflow

1. **Open Today.** Clear the *Needs attention* panel first — act on any stop/target/
   exit-rule hits and triggered alerts.
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
  broker confirmation. Enter an account ID once, flip on **Sync automatically in the
  background**, and pick an interval (1m–30m); it then keeps itself current with no further
  clicking, independent of any open tab.
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
