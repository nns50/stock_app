# User Guide

A practical, page-by-page guide to using **stock-app** — your personal day-trading
& options-trading assistant. This is a **decision-support and tracking** tool: it
screens, scores, sizes, and journals so *you* can make better, more consistent
decisions. It is **not** a signal service, it makes no predictions, and it never
places trades.

> Looking for *how to trade profitably with it*? See the
> **[Strategy Playbook](./STRATEGY_PLAYBOOK.md)**. Looking for install/config?
> See the main **[README](../README.md)**.

---

## Contents

1. [Getting started in 3 commands](#getting-started-in-3-commands)
2. [The interface](#the-interface)
3. [Today (dashboard)](#today-dashboard)
4. [Screener](#screener)
5. [Watchlist](#watchlist)
6. [Options](#options)
7. [Positions & P&L](#positions--pl)
8. [Journal & analytics](#journal--analytics)
9. [Alerts](#alerts)
10. [Settings](#settings)
11. [A recommended daily workflow](#a-recommended-daily-workflow)
12. [Data, privacy & providers](#data-privacy--providers)

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

---

## Today (dashboard)

Your at-a-glance morning screen.

- **Stat tiles:** Open P&L, Unrealized, Open positions, Gross exposure, and **Needs
  attention** (a count that turns amber when something wants a decision).
- **Today's setups** — a morning shortlist that **auto-scans once** when you first land
  on Today each session (or hit **Scan** / **↻ Rescan** anytime). It runs the screener
  and ranks your universe. Toggle **Long / Short**, and sort by **Score**, **Gap**, or
  **Rel-vol** to surface the four things people watch at the bell; each row shows the
  score, gap %, relative volume, RSI, and a suggested ATR-based stop, links to the chart,
  and has a **+** to log a trade in that symbol (the form opens with it pre-filled). It's
  a transparent rule-based ranking — **not a buy signal**.
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
a black box** — every score can be traced to a formula.

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

---

## Options

Four tabs: **Chain**, **Entry scan**, **Exit rules**, **Strategy**. (Requires a
provider that exposes option chains — e.g. Tradier; demo mode also works.)

### Chain

The full option chain for a symbol + expiration, with **Greeks** (delta, gamma, theta,
vega), **IV**, and bid/ask. When a provider doesn't return Greeks, they're computed
with **Black–Scholes** (estimates — European exercise, no dividends, constant vol).

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

### Key option terms

- **Delta** ≈ price move per $1 of underlying, and a rough probability of finishing
  in-the-money. **POP** = probability of profit (a lognormal estimate). **IV rank** =
  0–100% position of current IV within its history. (Full glossary on the in-app
  **About** page.)

---

## Positions & P&L

Log trades, size them by risk, manage them, and track live P&L.

### Logging a trade (`+ Log trade`)

Open it with the header **+ Log** button or `n`. Stock or option, with: symbol, side,
quantity, entry price/premium, date, fees, (option) type/strike/expiration, **tags**
(click a suggestion chip to reuse a tag you've used before), **grade (A–F)**, **notes**,
an optional **stop** and **target**, and the **pre-trade checklist** (below).

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
  (which **weekday** you closed on, and how long you **held**) — each with
  its own count, total, win rate, and expectancy. This is how you discover *which
  setups and which behaviors* make you money.

### Curves & risk

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
  test** (account list / stock snapshot). Webull's v2 OpenAPI provides stock **and option**
  market data plus your account (market data needs an active OpenAPI subscription).
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
- **Quotes may be delayed** (commonly ~15 min on free tiers). The provider chip shows
  live vs demo. Responses are cached briefly and auto-polling is off by default.
- **Demo/synthetic data** is deterministic placeholder data for trying the app — it is
  clearly labeled and must **not** be used for real decisions.

---

> ⚠️ **Disclaimer.** This tool is for personal research and education. It is **not
> financial, investment, or trading advice**, and nothing in it is a recommendation to
> buy or sell anything. No guarantee of accuracy or performance; past results never
> guarantee future outcomes. Trading stocks and options carries substantial risk of
> loss. You are solely responsible for your decisions. The app does not connect to a
> broker and does not place orders.
