# Auto-Trade Risk Settings — a plain-English guide

This is a walkthrough of every risk setting on the **Auto-Trade** page's
**Configuration** card: what each one does, what it defaults to, and a worked example
for each using round numbers so the math is easy to follow. It's written for someone
who wants to understand the settings well enough to tune them with confidence, not
just click around.

> Want to set all of these at once from a target daily gain % instead of one at a time?
> See **[Tune from target daily gain](./TUNE_FROM_TARGET.md)**. Looking for a
> page-by-page tour of the whole app? See the **[User Guide](./USER_GUIDE.md)**. Looking
> for how to trade profitably in general (position sizing, R-multiples, the Edge
> Report)? See the **[Strategy Playbook](./STRATEGY_PLAYBOOK.md)**. Looking for the
> original engineering spec these settings implement? See
> **[AUTOTRADING_SPEC.md](./AUTOTRADING_SPEC.md)**. Looking for install/config? See the
> main **[README](../README.md)**.

---

## Contents

1. [Where these settings live](#1-where-these-settings-live)
2. [The cheat sheet](#2-the-cheat-sheet)
3. [The big picture: how one trade gets approved](#3-the-big-picture-how-one-trade-gets-approved)
4. [Every setting, one at a time](#4-every-setting-one-at-a-time)
5. [Worked example: why "raise the position cap" didn't fix it](#5-worked-example-why-raise-the-position-cap-didnt-fix-it)
6. [How to change a setting](#6-how-to-change-a-setting)
7. [Quick answers for common situations](#7-quick-answers-for-common-situations)
8. [Backtesting uses its own numbers](#8-backtesting-uses-its-own-numbers)

---

## 1. Where these settings live

Open the **Auto** tab and expand the **Configuration** card at the top (click its
header if it's collapsed). Top to bottom, you'll find:

- A master **enabled** switch for the automated loop.
- **Risk profile** — `Moderate` or `Aggressive`. This is a label only (see
  [§4](#risk-profile)) — every number below is set independently of it.
- **Options strategy** — what kind of options trade the loop builds. Not a risk
  setting; skip it for this guide.
- **Account equity ($)** — the dollar figure every percentage below is calculated
  against. **Every setting in this guide is meaningless until this is set** — the risk
  engine blocks all trading until it is.
- **Max concurrent positions** — one combined slot count for stocks and options
  together.
- The seven risk-check fields this guide covers in detail: **risk per trade**,
  **max daily drawdown**, **step-down after (consecutive losses)**, **step-down size
  cut**, **max aggregate open risk**, **max correlated exposure**, and **max trades
  per day**.
- Two **correlation-methodology** fields right below max correlated exposure:
  **correlation lookback (days)** and **correlation threshold (|r|)** — they define
  *how* two tickers count as "correlated" for that cap, rather than adding a new cap
  of their own.

Each of the ten numeric settings (max concurrent positions, the seven risk fields,
and the two correlation-methodology fields) has its own input box and its own
**Save** button — you can change one without touching any of the others.

## 2. The cheat sheet

| Setting | Answers the question | Default | Unit |
|---|---|---|---|
| **Risk profile** | Nothing — it's a label | `Moderate` | — |
| **Max concurrent positions** | How many positions can be open at once? | 2 | count |
| **Risk per trade (%)** | How much of my account can one trade lose? | 1% | % of equity |
| **Max daily drawdown (%)** | How much can I lose today before new trades stop? | 3% | % of equity |
| **Step-down after (losses)** | How many losses in a row triggers smaller sizing? | 2 | count |
| **Step-down size cut (%)** | How much smaller do trades get once step-down is active? | 50% | % cut |
| **Max aggregate open risk (%)** | How much can ALL open positions lose at once, combined? | 2% | % of equity |
| **Max correlated exposure (%)** | How much capital can sit in similarly-moving tickers? | 6% | % of equity |
| **Max trades per day** | How many new positions can open in one day? | 6 | count |
| **Correlation lookback (days)** | How many days of price history define "correlated"? | 30 | trading days |
| **Correlation threshold (\|r\|)** | How similar do two tickers' moves have to be to count as "correlated"? | 0.7 | Pearson r (0-1) |

Every default above matches the app's original `MODERATE` preset, so if you've never
touched these fields, nothing about how the loop behaves has changed — they're just
editable now instead of baked into a dropdown.

## 3. The big picture: how one trade gets approved

Every 60 seconds, the automated loop does this for each candidate symbol:

1. **Screen** — is this symbol even eligible? (Not on the real-estate exclusion list,
   passes the volatility/volume filters, etc.)
2. **Decide** — build an entry price, a stop price, and a target price.
3. **Size** — figure out how many shares (or contracts) to buy, using **risk per
   trade** (and **step-down**, if it's active).
4. **Check** — run the sized trade past every cap in the table above. **All of them
   have to pass.** A trade that's perfectly sized and has plenty of room on five out
   of six caps still gets blocked if it fails the sixth.
5. **Execute** — only if step 4 passed.

That last point in step 4 is the single most important thing to understand about
this page: **the caps don't average out or combine into one score — each one is a
separate yes/no gate, and the tightest one wins.** This is exactly what happened in
the incident that prompted this guide (see [§5](#5-worked-example-why-raise-the-position-cap-didnt-fix-it)).

## 4. Every setting, one at a time

All examples below use a **$100,000 account** so the numbers are easy to follow —
just move the decimal point for your own equity.

### Risk profile

**What it does today: nothing, by itself.** `Moderate` vs. `Aggressive` used to be a
preset that silently set all seven risk fields below to different values. It no
longer does that — every one of those fields is its own setting now, and switching
this dropdown leaves every one of them exactly where you left it.

It's kept around for two reasons: it's still saved with every trade in the journal
(so your history shows what posture you intended at the time), and switching to
`Aggressive` still pops a one-time confirmation dialog — flipping a label that's
permanently attached to your trade history should still be a deliberate click, not an
accident.

### Max concurrent positions

**The size of one shared pool of "slots."** Stocks and options draw from the *same*
pool — if this is set to 15, you can have 15 stock positions, 15 option positions, or
any mix that adds up to 15, but never 16 total. A new trade is blocked once
`open positions == this number`, regardless of how much risk those positions
represent.

*Example:* set to 15, with 2 positions currently open → 13 slots free. This check
alone would let a new trade through.

**Only counts positions auto-trading itself placed.** A position you entered
manually from the Trade page never counts toward this — or toward max aggregate
open risk below, or the daily P&L/consecutive-loss figures either. The Auto page's
Monitoring panel and this check both look at the same auto-trade-only figure, so
what you see there is what's actually gating new entries.

### Risk per trade (%)

**How much of your account one single trade is allowed to lose if its stop is hit.**
This is the number the position-size calculation is built from directly.

*How it turns into a share count:* `risk per trade % × account equity` = your dollar
risk budget for the trade. Divide that by the distance between entry and stop
(`entry price − stop price`), and round down to a whole share.

*Example:* $100,000 account, 1% risk per trade → **$1,000 risk budget**. Entry $50,
stop $48 → **$2 stop distance**. `$1,000 ÷ $2 = 500 shares`. If the stop gets hit,
you lose (about) $1,000 — 1% of the account, exactly as configured.

For options, this same percentage applies to **premium paid**, not the underlying's
notional value — 1% risk on a $100,000 account means at most $1,000 spent on premium
for that position.

### Max daily drawdown (%)

**A same-day circuit breaker.** Once today's *realized* losses (only trades that have
actually closed — not open positions moving against you on paper) reach this
percentage of your account, the loop stops opening *new* positions for the rest of
the day. It does **not** close anything already open — their stops and targets keep
being checked normally.

*Example:* $100,000 account, 3% max daily drawdown → the halt line is **-$3,000**.
Lose $3,000 or more in closed trades today, and no new entries happen until
tomorrow.

This is different from the "max aggregate open risk" setting below — this one only
reacts *after* a loss has already happened; that one is a *before-the-fact* check.

### Step-down after (consecutive losses) & step-down size cut (%)

**One mechanism, two numbers.** After you lose this many trades in a row, every new
trade's position size gets cut by this percentage — automatically, no action needed
— until a winning trade breaks the streak.

*Example:* default settings (step down after 2 losses, cut 50%). Two losing trades in
a row → the *next* trade sizes at 0.5% risk per trade instead of 1% (half the normal
size) — i.e. in the earlier example, ~250 shares instead of 500. Win one trade, and
sizing goes back to normal (1%, 500 shares) on the trade after that.

The idea: after a losing streak, trade smaller until you've proven you're back on
track — a much gentler response than the hard stop the daily-drawdown halt applies.

### Max aggregate open risk (%)

**The most important setting to understand, and the one most likely to surprise
you.** This is a *pre-trade* check, separate from every other setting: before opening
*any* new position, the app adds up the dollar risk (size × stop distance) of every
position **already open**, plus what the *new* trade would add — and if that combined
total would exceed this percentage of your account, the trade is blocked. It doesn't
matter if you have 13 free position slots and haven't hit your daily loss limit —
this check runs independently of both.

*Example:* $100,000 account, 2% max aggregate open risk → **$2,000 combined risk
budget**, shared across every open position at once. Two positions are already open,
each sized at the default 1% risk ($1,000 each) → that's **$2,000 already
committed — the entire budget, with zero left over.** A third trade gets blocked
here even though it might easily be within the concurrent-position limit.

Why this check exists at all: it protects against several positions getting stopped
out **at the same time** (a broad market gap, for instance) for more than your daily
drawdown limit was ever meant to allow — since the daily halt only reacts *after* the
damage is done, this is the check that prevents the damage from being too large in
the first place.

**This is risk, not cash — and it's auto-trade's own risk, not your account's whole
activity.** Two things that look related but aren't: having enough buying power to
afford a position doesn't mean there's room in this budget (cash and risk are
checked independently); and a position you placed manually from the Trade page
never counts toward this figure, even though it's real money in the same account.
If the Monitoring panel's "Aggregate open risk" tile shows plenty of headroom but a
candidate is still failing this check, it's almost always one of auto-trade's *own*
positions using up the budget you haven't accounted for — not a bug, and not your
manual trades either.

Stocks and options share this one budget too, same as max concurrent positions.

### Max correlated exposure (%)

**A concentration check for tickers that tend to move together.** Separate from
aggregate open risk (which is about *how much you could lose*), this one is about
*how much capital* (not risk — the full position value) is already sitting in
tickers that are statistically correlated with a new candidate — meaning their daily
price moves have tracked each other closely, by default a correlation of 0.7 or
higher over the last 30 trading days (both numbers are their own editable settings,
covered right after this one). If that already-correlated capital exceeds this
percentage of your account, the new, similarly-moving trade is blocked, even though
it would be a "different" symbol.

*Example:* $100,000 account, 6% max correlated exposure → **$6,000 cap**. You hold a
$5,000 position in one semiconductor stock, and a candidate in a second
semiconductor stock (moving in near lock-step with the first, historically) would add
another $5,000 of position value → $10,000 total in correlated names, which exceeds
the $6,000 cap, so it's blocked — protecting you from what looks like "two trades"
but is really one bet, doubled. That's the case when both positions are on the
**same side** (both long, or both short) — the usual case, and the only one possible
before the app could hold equity shorts at all.

Now that positions can be long or short, a correlated position on the **opposite**
side from the candidate is a **hedge**, not a doubled bet, so it's netted out instead
of added: *same example, but your $5,000 semiconductor position is **short** and the
new candidate is a **long** in the closely-correlated second name* — already-correlated
exposure counts as $5,000 − $5,000 = **$0**, nowhere near the $6,000 cap, since the
two positions partially offset each other's risk rather than compound it. The netted
total is floored at $0 either way — a hedge can bring the counted exposure down to
zero, never into negative territory that would then "shield" other, unrelated risk
elsewhere.

The candidate's own size never counts against itself here — only capital that's
*already* committed to correlated names. A single, isolated first trade is never
blocked by this check just because it's "correlated with itself."

**Note:** unlike the other checks, this one doesn't currently have its own tile on
the Monitoring dashboard — see [§7](#7-quick-answers-for-common-situations) for where
to actually see it in action.

### Correlation lookback (days) & correlation threshold (|r|)

**The two dials that decide what "correlated" even means, for the check above.**
Neither one is a cap by itself — they control the math max correlated exposure runs
against every candidate.

- **Correlation lookback (days)** — how many trading days of daily price returns are
  compared between two symbols. A shorter window reacts faster to a recent,
  possibly-temporary co-movement; a longer one only counts a more established
  relationship.
- **Correlation threshold (|r|)** — how closely two symbols' daily returns have to
  move together to count as "correlated" at all, as a Pearson correlation coefficient
  from 0 (no relationship) to 1 (move in perfect lockstep). Raising it makes the check
  *stricter* (fewer pairs qualify, so less capital counts against the cap); lowering
  it makes it *looser* (more pairs qualify).

*Example:* lowering the threshold from the default 0.7 to 0.5 means two tickers that
only loosely track each other now count as "correlated" — capital already sitting in
the second one starts counting against the max-correlated-exposure cap above, where
it wouldn't have at the stricter default.

Both default to the values the loop always used before they were configurable (30
days, 0.7), so leaving them untouched changes nothing.

### Max trades per day

**A simple hard cap on how many new positions can open in one calendar day** —
counting paper and live together, and stocks and options together. Once today's
count of placed orders reaches this number, no more new entries happen until the
next day, regardless of every other check passing.

*Example:* set to 6, and the loop has already placed 6 orders today → the 7th
candidate is blocked here, even with a great setup and plenty of room everywhere
else.

## 5. Worked example: why "raise the position cap" didn't fix it

This is the exact scenario that prompted this guide to be written, using the app's
own default numbers so you can reproduce it.

- **Max concurrent positions** raised to 15 — plenty of room, only 2 positions open.
- **Max aggregate open risk** still sitting at the default **2%** — nobody had
  touched it, because until recently there was nowhere in the UI to touch.
- Account equity: $100,000. Aggregate risk budget: **$2,000**.
- The 2 open positions were each sized at the default 1% risk per trade — **$1,000
  each, $2,000 combined.**

Every new candidate that reached the risk-check stage failed the exact same rule:
`max_aggregate_open_risk`, because the account's entire $2,000 budget was already
spent by the two open positions — with **zero dollars of headroom left**, no matter
how good the next signal looked or how many of the 15 position slots were still
free. Raising the position cap did nothing, because it was never the binding
constraint — the aggregate-risk cap was, silently, the whole time.

That's the reason all seven fields in [§4](#4-every-setting-one-at-a-time) are now
independently editable: before this fix, `max aggregate open risk` had no dial at
all — it was permanently welded to whatever the `Moderate`/`Aggressive` dropdown
implied, with no way to raise it without also changing five other numbers you might
not have wanted to touch.

## 6. How to change a setting

1. Type the new value into the field.
2. Its **Save** button lights up as soon as the value differs from what's currently
   saved (it's greyed out otherwise, so you can't accidentally re-save an unchanged
   number).
3. Click **Save**. A toast confirms it, and the change is live immediately — the
   automated loop reads the saved value fresh on its very next cycle (within a
   minute), no restart needed.
4. Percentage fields are clamped to a sane 0–100 range automatically; count fields
   (max concurrent positions, step-down trigger, max trades per day) reject negative
   numbers and fall back to the last saved value.

Changing any of these settings never touches positions you already have open — it
only affects trades the loop considers *from that point forward*.

## 7. Quick answers for common situations

**"Nothing is trading and I don't know why."** Open the **Monitoring** panel further
down the Auto-Trade page — it shows a live "used vs. limit" reading for five of the
six risk-check rules, and turns a tile red once that cap is the reason a trade would
be blocked:

- **Open positions** vs. max concurrent positions
- **Aggregate open risk** vs. its $ cap
- **Day P&L** vs. the daily-drawdown halt level
- **Trades today** vs. max trades per day
- **Consecutive losses** vs. the step-down trigger

**Max correlated exposure** is the one exception — since it's relative to a specific
candidate rather than one portfolio-wide number ([§4](#4-every-setting-one-at-a-time)
explains why), its tile shows the **last candidate actually checked** instead of a
live gauge: symbol, $ amount, how long ago, and a red **BLOCKED** flag if that's what
stopped it. It reads "no candidate checked yet" until the loop (or a manual **Run
screen**) has evaluated at least one — running a screen also gives you a fuller,
per-candidate **approved/blocked** badge if you want more than just the latest one, or
check the **Recent activity** feed for a `risk_check` / `blocked` entry.

**"The Monitoring panel shows plenty of headroom, but a candidate still fails
`max_aggregate_open_risk` (or another check)."** First, make sure you're reading the
right tile — the Auto-Trade page has a separate Paper/Live/Live options section, each
with its *own* "Open positions"/"Aggregate open risk" pair; they track completely
independent books, so the Paper section's numbers say nothing about what's blocking a
Live entry. Once you've confirmed you're looking at the right section: every figure
on this page — concurrent positions, aggregate open risk, daily P&L, consecutive
losses — counts *only* positions auto-trading itself placed. A manually-placed trade
from the Trade page is real money in the same account, but it was never auto-trade's
decision, so it's deliberately excluded from all of these. It won't inflate the
numbers you see here, and it won't get silently protected by them either — you're
managing that position's risk yourself.

**"I want the loop to trade more."** In rough order of how likely each one is to be
the actual bottleneck: raise **max aggregate open risk** first (per
[§5](#5-worked-example-why-raise-the-position-cap-didnt-fix-it), it's the most
commonly-binding cap and the easiest to overlook), then **max concurrent positions**,
then **max trades per day**. Raise **risk per trade** only if you deliberately want
bigger individual positions, not just more of them — it doesn't unblock anything by
itself. Consider each change carefully: every one of these exists to cap a real
downside.

**"I want the loop to trade less / more conservatively."** Lower **risk per trade**
and/or **max aggregate open risk** first — they shrink every position and the total
exposure across all of them. Lowering **max daily drawdown** makes a bad day end
sooner; lowering **step-down after (losses)** makes the loop downsize itself sooner
after a rough stretch.

## 8. Backtesting uses its own numbers

The **Backtest & walk-forward** tool further down the Auto-Trade page has its own,
completely separate `Moderate`/`Aggressive` risk-profile selector — changing your
*live* settings above never changes a backtest's results, and running a backtest
never touches your live configuration. This is deliberate: a backtest is a
self-contained "what if," the same way its `starting equity` and
`max concurrent positions` fields are already independent of your real account. If
you want a backtest that matches your current live settings exactly, you'd need to
pick the values by hand — there's no "copy from live config" button today.

The **correlation lookback/threshold** settings are folded into that same
self-contained bundle now too — previously, backtests always measured correlation
with the same fixed 30-day/0.7 numbers as live trading, since those were global
constants rather than part of the risk-profile bundle; today they resolve the same
way the other seven fields do (the bundle's value, unless overridden), even though
there's no dedicated input for them in the backtest tool yet either.

---

> ⚠️ **Disclaimer.** This guide describes how the app's automated risk checks work.
> It is **not financial, investment, or trading advice**, and nothing in it is a
> recommendation for what any setting "should" be — those are your calls to make.
> Every risk check here only limits what the app's own paper/live loop will do; it
> cannot eliminate the risk of loss. Past results never guarantee future outcomes.
> You are solely responsible for your decisions.
