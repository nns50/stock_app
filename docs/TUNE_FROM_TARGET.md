# Tune from target daily gain — a guide

**Tune from target** is a shortcut for setting up the whole Auto-Trade risk config at
once. Instead of hand-tuning the ~30 risk fields one at a time, you name a **target
daily gain %**, and it works backward from that (plus your account equity) to a full set
of settings — per-trade risk, exposure caps, screening filters, options selection, and
the dollar caps — sized so that target is _reachable_.

It's a **preview-then-apply** tool: it shows you exactly what every field would become
before anything changes, and every field stays editable afterward. It never places a
trade and never turns live trading on.

> This is decision-support, **not financial advice or a promise of any gain**. The tool
> will happily size up to chase a number your system may not actually produce. Read the
> [Caveats](#8-caveats-read-this) before you lean on it.

> Looking for what each individual risk setting does? See
> **[Auto-Trade Risk Settings](./AUTOTRADE_RISK_SETTINGS.md)**. Looking for the general
> theory of position sizing (R-multiples, Kelly)? See the
> **[Strategy Playbook](./STRATEGY_PLAYBOOK.md)**. A page-by-page tour of the app is in
> the **[User Guide](./USER_GUIDE.md)**.

---

## Contents

1. [Where it lives](#1-where-it-lives)
2. [Before you start](#2-before-you-start)
3. [Step by step](#3-step-by-step)
4. [Choosing a sizing basis](#4-choosing-a-sizing-basis)
5. [How your target maps to every setting](#5-how-your-target-maps-to-every-setting)
6. [What it changes — and what it never touches](#6-what-it-changes--and-what-it-never-touches)
7. [Reading the preview and warnings](#7-reading-the-preview-and-warnings)
8. [Caveats — read this](#8-caveats-read-this)
9. [A full worked example](#9-a-full-worked-example)

---

## 1. Where it lives

Open the **Auto** tab, stay on the **Configuration** view, and expand the **Tune from
target daily gain** card (it sits right below **Core settings**, collapsed by default —
click its header to open it).

## 2. Before you start

Set your **Account equity ($)** first (in Core settings, just above). Every number the
tuner produces scales with it, so until equity is set the card just prompts you to set
it and won't preview anything. You can type equity in manually or sync it from Webull.

## 3. Step by step

1. **Enter a target daily gain %** — the amount you want to _attempt_ to make on a good
   day (e.g. `5`).
2. **Pick a sizing basis** — `Expected day` or `Perfect day` (see
   [§4](#4-choosing-a-sizing-basis)). The preview re-computes instantly as you flip it.
3. **Read the preview** — a table of every setting that would change, **Current →
   Tuned**, plus the resulting band, the per-trade risk it solved for, and any warnings.
4. **Apply** — click **Apply tuned settings**. If the tune lands in the aggressive band,
   you'll get the same confirmation dialog any switch to the AGGRESSIVE label shows.
   Nothing is saved until you click this.
5. **Review and adjust** — the fields below are now filled in and remain fully editable.
   Change anything you disagree with.

To undo, click **Reset to moderate** — it restores the standard moderate baseline,
scaled to your equity.

The **target %** and **sizing basis** you pick are remembered in your browser, so the
card comes back to your last choice after a reload or after switching views — they're a
preview control, not a saved Auto-Trade setting (what **Apply** writes is the derived
risk config below, not the target itself).

## 4. Choosing a sizing basis

Both bases use the **same formula** — they differ only in one assumption about how your
trading day goes:

```
riskPerTradePct = targetDailyGainPct ÷ (tradesPerDay × edgeR)
```

| Basis           | `edgeR` is…                              | Meaning                                                        | Sizes… |
| --------------- | ---------------------------------------- | -------------------------------------------------------------- | ------ |
| **Expected day** | your _average_ R per trade (`winRate×R − lossRate`, assuming a **45%** win rate at the band's reward:risk) | The target is your **average** day — what you'd make in a typical session | **up** (more risk per trade) |
| **Perfect day** | the reward multiple `R` itself           | The target is your **best-case ceiling** — only reached if _every_ trade wins | **down** (less risk per trade) |

Because `edgeR` is smaller on the Expected basis (your average trade nets a fraction of
its target), you have to risk **more** per trade to hit the same daily number. On the
Perfect-day basis you assume every trade wins, so you need **less**.

**Same target, different sizing.** A 5%/day target with 6 trades/day at a 2:1
reward:risk:

- **Expected day**: `edgeR = 0.45×2 − 0.55 = 0.35` → risk = `5 ÷ (6 × 0.35)` ≈ **2.4%**
  per trade.
- **Perfect day**: `edgeR = 2` → risk = `5 ÷ (6 × 2)` ≈ **0.4%** per trade.

The toggle is you choosing which assumption to size the account on. `Expected day` is
the more honest default (it doesn't assume you never lose); `Perfect day` is the more
conservative sizing for a given target.

## 5. How your target maps to every setting

### The band

Your target picks an **aggressiveness band**, which sets the "shape" of the config:

| Target daily gain | Band             |
| ----------------- | ---------------- |
| ≤ 3%              | **Conservative** |
| 3% – 8%           | **Moderate**     |
| > 8%              | **Aggressive**   |

A higher target loosens **everything**, not just position size. Each band sets:

| Setting                    | Conservative | Moderate | Aggressive |
| -------------------------- | -----------: | -------: | ---------: |
| Max concurrent positions   |            2 |        2 |          5 |
| Max trades/day             |            4 |        6 |         10 |
| Target R multiple          |            2 |        2 |        2.5 |
| Step-down after losses     |            2 |        2 |          3 |
| Max correlated exposure    |           4% |       6% |        12% |
| Max sector exposure        |          15% |      20% |        35% |
| Min relative volume        |         2.0× |     1.5× |       1.2× |
| Min share price            |           $5 |       $2 |         $1 |
| Min avg volume (shares/day) |    1,000,000 |  500,000 |    200,000 |
| Min signal score (conviction floor) | 60 |       50 |         40 |
| Max ticker ATR%            |          10% |      15% |        20% |
| Max market ATR%            |           4% |       5% |         7% |
| Options delta band         |    0.25–0.50 | 0.30–0.60 |  0.40–0.70 |
| Options max spread %        |           8% |      10% |        15% |
| Options DTE window         |        14–60 |     7–60 |       3–45 |
| Options IV-rank ceiling    |           60 |       70 |         85 |
| Options max IV/RV ratio    |          1.0 |      1.2 |        off |
| Options stop-loss / take-profit | 40% / 60% | 50% / 80% | 60% / 100% |
| Risk-profile label         |     Moderate | Moderate | Aggressive |

A few notes on the rows:

- **The liquidity floors never disable.** Cheap, thin names are where the bid-ask
  spread eats the biggest bite out of a stop, so even the aggressive row keeps the
  engine's old constants ($1 / 200k shares) as its floor.
- **The conviction floor** is anchored on the conviction grades: the conservative row's
  60 is the default B-grade threshold — "only trade B-grade or better."
- **The IV/RV cheapness gate** (max ratio of implied to 20-day realized vol) is
  tightest where the band is most patient, and **off** in the aggressive row — the
  gate skips entries when realized vol can't be computed, and that band needs the
  trade flow.
- **The options IV-rank _floor_ is always reset to 0** (not in the table): the bands
  select long-premium contracts, where cheap implied vol is the goal and the ceiling
  is the active gate. Writing 0 clears any leftover experimental floor that would
  contradict a fresh tune.

The **Moderate** band is the published baseline **Reset to moderate** restores — close
to, but deliberately not identical to, the shipped defaults. The moderate row turns on
a few gates that ship disabled (options stop-loss/take-profit, the conviction floor,
the IV/RV gate) and sets the liquidity floors a notch above the engine's old constants:
an _untouched_ config keeps its old behavior, but a preset you explicitly ask for takes
a stance. Every difference shows up in the preview before you apply.

### The per-trade risk (solved)

`riskPerTradePct` is solved from your target using the band's trades/day and reward
multiple, then **clamped to a maximum suggestion of 10%** — see
[§7](#7-reading-the-preview-and-warnings).

### The settings derived from that risk

| Setting                          | How it's set                                                            |
| -------------------------------- | ----------------------------------------------------------------------- |
| **Daily drawdown halt**          | `tradesPerDay × riskPerTrade × 0.75` — roughly a day where three-quarters of your trades lose. Floored at 2%, capped at 40%. |
| **Max aggregate open risk**      | `riskPerTrade × maxConcurrentPositions` (so the book can actually hold its intended positions). Capped at 30%. |
| **Live max order ($)**           | `equity × 20% / 25% / 35%` by band — a fat-finger backstop, not primary sizing. |
| **Live max daily loss ($)**      | `equity × dailyDrawdownHalt%` — the dollar version of the halt above.   |
| **Live max orders/day**          | equals max trades/day.                                                   |

The options live caps mirror the equity ones.

### The dollar caps stay anchored to your equity

The percent-based settings re-scale themselves — account equity is synced from the
broker every loop tick, and a percent is applied to it at decision time. The **dollar**
caps above, though, are stored as literal dollars, frozen at the equity they were
derived from. Left alone, they drift from the tune's intent in both directions: as the
account grows they quietly tighten, and as it shrinks they quietly **loosen** — a $903
daily-loss cap on a book that has fallen from $6.9k to $4k is a 22% halt wearing a 13%
label, exactly when losses are compounding.

So applying a tune also records the equity it derived those caps from (the _anchor_),
and the loop **re-derives the four dollar caps automatically** whenever synced equity
has moved **15% or more** (either direction) from that anchor, using the same formulas
in the table above — then moves the anchor to the new equity, so mark-to-market noise
can never make it churn. Each re-anchor appears in **Recent activity** as a
`live_caps_reanchored` config event showing the old → new value of every cap it moved.

Hand-edits stay yours: a cap is only re-derived while it still equals the value the
anchor implies. One you've changed by hand is skipped (and named in the event), and
editing the drawdown-halt percent by hand likewise takes the daily-loss caps out of
the automation's reach from the next re-anchor on. Re-applying a tune re-arms
everything. Configs from before this feature have no anchor recorded, so nothing
re-anchors until a tune is applied once.

## 6. What it changes — and what it never touches

The tuner writes **only** the risk/aggressiveness settings, screening filters, contract
selection, and the equity-scaled dollar caps listed above.

It **never touches** — by design, so a "chase a daily %" preset can never do something
dangerous or surprising:

- Your **live-trading enable** switch or **live-options enable** switch
- The **kill switch** or the master **auto-trading enabled** switch
- Your **Webull account ID** or **account equity** (equity is an _input_)
- The **live probation** ramps (the extra size cut for your first live trades)
- The "allow naked short" flag, **trade direction**, or the scoring-factor opt-ins
  (relative strength, sentiment, benchmark)
- **Movers discovery** — whether premarket movers feed the candidate set is a choice
  about _where_ trades come from, not how aggressively to take them
- Correlation methodology, the exit-refinement toolkits (trailing stops, break-even,
  partial exits), the regime/equity-curve/expectancy sizing overlays, the
  earnings/macro/session blackout windows, or **auto-tune from realized edge**

(In the code this is a machine-checked classification: every config field must be on
the tuner's allowlist or its documented never-tuned list, so a newly added setting
can't silently end up in neither.)

If you want the tune to stick exactly, note that **auto-tune from realized edge** (if
you have it on) will keep nudging your per-trade risk over time — the preview warns you
when that's the case.

## 7. Reading the preview and warnings

The header line shows the **band**, the solved **risk / trade** (amber when it's ≥ 3%),
and the `edgeR` used. The table lists every field that would change, current → tuned.

Warnings you may see:

- **Risk capped.** If your target would require more than **10%** risk per trade, the
  suggestion is capped there and warns you. (You can still hand-enter a higher number in
  the field afterward — the tool won't propose account-suicide sizing itself, but it
  doesn't stop you.)
- **Aggressive sizing.** Any suggested risk ≥ 3% gets a reminder that a losing streak
  compounds fast, and to make sure the drawdown-halt number is one you can stomach.
- **Auto-tune is on.** A note that auto-tune will re-move the risk % over time.

## 8. Caveats — read this

- **It is not derived from a proven edge.** Unlike the Journal's Kelly suggestion (which
  comes from your _realized_ win rate and payoff), this sizes from _ambition_. It will
  size up to chase a target your system may never actually hit.
- **Higher target = bigger swings both ways.** The daily-drawdown halt it sets is the
  amount you're accepting you might lose on a bad day in exchange for a shot at the good
  one. Look at that number before you apply.
- **The 45% win-rate assumption is fixed**, not read from your history. If your real win
  rate is lower, the Expected-day sizing is _more_ aggressive than it looks.
- **It never enables live trading.** Applying a tune only changes settings; you still
  have to turn live trading on yourself, deliberately, with its own typed confirmation.

## 9. A full worked example

**Account: $1,000. Target: 5%/day. Basis: Expected day.**

1. Band → **Moderate** (5% is in the 3–8% range), which sets 6 trades/day at a 2:1
   reward:risk.
2. `edgeR = 0.45×2 − 0.55 = 0.35`.
3. `riskPerTradePct = 5 ÷ (6 × 0.35)` ≈ **2.38%** (≈ $23.80 risked per trade).
4. Derived:
   - Daily drawdown halt = `6 × 2.38 × 0.75` ≈ **10.7%** (≈ **$107**).
   - Max aggregate open risk = `2.38 × 2` ≈ **4.76%**.
   - Live max order = `1,000 × 25%` = **$250**; live max daily loss = **$107**; live max
     orders/day = **6**.
5. **Flip to Perfect day** and the same 5% target re-sizes to **0.42%** risk and a **2%**
   drawdown halt (floored) — because now you're assuming every trade wins.

Apply the one you're comfortable with, review the filled-in fields, and adjust anything
by hand. To go back, hit **Reset to moderate**.
