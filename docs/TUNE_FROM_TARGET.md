# Tune from target daily gain — a guide

**Tune from target** is a shortcut for setting up the whole Auto-Trade risk config at
once. Instead of hand-tuning the ~30 risk fields one at a time, you name a **target
daily gain %**, and it works backward from that (plus your account equity) to a full set
of settings — per-trade risk, exposure caps, screening filters, options selection, and
the dollar caps — sized so that target is _reachable_.

It's a **preview-then-apply** tool: it shows you exactly what every field would become
before anything changes, and every field stays editable afterward. It never places a
trade and never turns live trading on.

Since 2026-08-21 the target is also a **live daily goal**, not just a one-time
calibration: applying a tune stores the target %, and each ET day the loop snapshots
the account's starting value, tracks progress toward
`dayStart × (1 + target%)` during the session, and — once reached — **banks the day**:
new live entries and scale-ins halt until the next trading day, while exits,
reconcile, the broker sync, and paper trading all keep running. See
[§6a](#6a-the-live-daily-goal-bank-the-day) for exactly how it behaves.

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
   - [6a. The live daily goal — bank the day](#6a-the-live-daily-goal--bank-the-day)
   - [6b. The daily goal — what the record says](#6b-the-daily-goal--what-the-record-says)
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
card comes back to your last choice after a reload or after switching views. Since
2026-08-21, **Apply also stores the target % itself** (`targetDailyGainPct`) — that's
what arms the live daily goal in [§6a](#6a-the-live-daily-goal--bank-the-day). The
basis stays a preview-side control (it shapes the sizing, not the goal).

## 4. Choosing a sizing basis

All three bases use the **same identity** — they differ only in where the two inputs
come from:

```
expected day %  =  tradesPerDay × riskPerTradePct × edgeR        (forward)
riskPerTradePct =  targetDailyGainPct ÷ (tradesPerDay × edgeR)    (the tune: its inverse)
```

In the code both directions are one function each (`expectedDailyGainPct` /
`riskPerTradeForTarget` in `targetTune.ts`), and everything that shows you an
"expected day" — the evidence line under every preview, the Monitoring card — goes
forward through the same identity the tune inverts, so the two can never disagree.

| Basis           | `edgeR` is…                              | `tradesPerDay` is… | Meaning                                                        | Sizes… |
| --------------- | ---------------------------------------- | ------------------ | -------------------------------------------------------------- | ------ |
| **Expected day** | an _assumed_ average R per trade (`winRate×R − lossRate`, a **fixed 45%** win rate at the band's reward:risk) | the band's max trades/day | The target is your **average** day — _if_ you win 45% of the time | **up** (more risk per trade) |
| **Perfect day** | the reward multiple `R` itself           | the band's max trades/day | The target is your **best-case ceiling** — only reached if _every_ trade wins | **down** (less risk per trade) |
| **Realized** (2026-09-07) | your **realized** average R per closed autotrade trade over the last 40 sessions | your realized **median entries per session on the sessions you traded**, bounded by the band's cap | The target is your average day **as the record shows it** | whatever the record says — often much less than Expected assumes |

The **Realized** basis is only offered on a record worth sizing on: at least **20**
R-scored closed live trades over at least **20 active sessions** (sessions the book
actually traded on — the first production read found the live book trading on 14 of its
last 40 sessions, and a median over all 40 was a meaningless 0), a **positive** average
R, and some measured trade flow. Otherwise the preview **refuses** it with a 400 naming the
shortfall ("7 of 20 trades over 3 of 20 sessions"), and the toggle shows the count. It
refuses rather than quietly answering under another basis: a preview whose basis differs
from the one you asked for would be exactly the silent substitution this basis exists
to end. A non-positive realized edge supports **no** daily target at all — sizing cannot
fix that; the fix is on the entry side.

Because `edgeR` is smaller on the Expected basis (your average trade nets a fraction of
its target), you have to risk **more** per trade to hit the same daily number. On the
Perfect-day basis you assume every trade wins, so you need **less**.

**Same target, different sizing.** A 5%/day target with 6 trades/day at a 2:1
reward:risk:

- **Expected day**: `edgeR = 0.45×2 − 0.55 = 0.35` → risk = `5 ÷ (6 × 0.35)` ≈ **2.4%**
  per trade.
- **Perfect day**: `edgeR = 2` → risk = `5 ÷ (6 × 2)` ≈ **0.4%** per trade.

The toggle is you choosing which assumption to size the account on. `Expected day` is
the more honest of the two modelled bases (it doesn't assume you never lose); `Perfect
day` is the more conservative sizing for a given target; `Realized` is not an assumption
at all.

### The record beside every preview — the evidence line

Whichever basis you pick, the preview also shows **your record**: realized average R and
the number of closed trades behind it, the median entries per session on the sessions
it traded (and how many of the window's sessions those were), the **expected day at
your current risk %** and **at the tuned risk %** (both from the forward identity above,
so "expected day" means a day the book trades), and how many of those expected days the
target is.
When the target is more than **2×** the expected day at the tuned sizing, a warning says
the bank line and the give-back levels stamped from it will rarely engage — the state the
live book was in when this shipped (a 3% goal against a ≈ 0.6% expected day). When a
reliable record shows a non-positive edge, the warning says that instead. A thin record
is shown as thin ("7 of 20 trades, 3 of 20 sessions"), never hidden.

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

`riskPerTradePct` is solved from your target through `riskPerTradeForTarget` — the band's
trades/day and reward multiple on the two modelled bases, your realized flow and edge on
the Realized basis — then **clamped to a maximum suggestion of 10%** — see
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
has moved **5% or more** (either direction) from that anchor, using the same formulas
in the table above — then moves the anchor to the new equity, so mark-to-market noise
can never make it churn. Each re-anchor appears in **Recent activity** as a
`live_caps_reanchored` config event showing the old → new value of every cap it moved.

**5% since 2026-09-12, down from 15%.** At 15% the caps lagged real equity by weeks:
the account ran from $5.1k down to $3.5k and back without a single re-anchor, so every
dollar cap described an account that no longer existed. 5% is still far above per-tick
mark-to-market noise, and the anchor still moves on each re-anchor, so it cannot churn.

**A reading far below the anchor waits a session.** A drop of more than **25%** from the
anchor holds every cap where it is for that session and journals `equity_read_suspect`
instead of re-anchoring; the same low reading on the next session re-anchors normally.
This is the 2026-09-11 case: the account was traded by hand, equity read $5,129 in the
morning and $3,523 in the afternoon, and the caps were cut ~30% off the low reading
while the strategy's own book had not lost a cent. A real decline persists into the
next session; one afternoon's hand trading does not. Only DROPS wait — a rise
re-anchors on sight. Nothing else is delayed by the hold: every percent-of-equity
rule (the drawdown halt, the aggregate risk cap, per-trade risk) still applies to live
equity at decision time.

**The options per-order cap has its own formula** (2026-09-12). It used to be a copy of
the equity per-order cap, which is a SHARE-sized number: on 2026-09-06 that read $4,269
against an options budget that could not fund a $0.63 contract, so it was set by hand to
$300 and then frozen out of every re-anchor. It is now derived from the options sizer
itself — the largest notional a single-leg options order can carry, `equity ×
riskPerTradePct ÷ optionsDisasterStopPct`, times the same 1.5 headroom — so it scales
with the account like everything else and no longer needs re-typing.

Hand-edits stay yours: a cap is only re-derived while it still equals the value the
anchor implies. One you've changed by hand is skipped (and named in the event), and
editing the drawdown-halt percent by hand likewise takes the daily-loss caps out of
the automation's reach from the next re-anchor on. Re-applying a tune re-arms
everything. The Auto page's **Live guardrail caps** panel shows each cap beside its
derived value and tags a frozen one, so a cap that has dropped out of the automation is
visible rather than merely believed; setting it back to the derived value hands it back.
Configs from before this feature have no anchor recorded, so nothing re-anchors until a
tune is applied once.

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

## 6a. The live daily goal — bank the day

Before 2026-08-21, the target % was **calibration only**: it solved a static
risk-per-trade once and was then forgotten — nothing in the loop knew a day had a
goal, so nothing stopped when it was reached and nothing reported progress. If your
day quietly gave back a green morning, the tune had no opinion about it.

Now the target is stored (`targetDailyGainPct`, stamped by every Apply) and tracked
live:

- **Each ET day starts a fresh base.** At the day's first loop tick, the synced
  account value is snapshotted as the day's baseline — effectively the prior
  session's close. The goal is the set % **of that day's value**, so a growing
  account compounds the goal daily and a shrinking one scales it down honestly.
- **Progress is measured on the whole account** — synced net liquidation, including
  unrealized P&L and anything you do manually in the same account. The goal is on
  the account's value, not on the loop's own fills.
- **Reaching the goal banks the day.** One `daily_target_reached` entry lands in
  Recent activity, and new **live** entries and scale-ins halt for the rest of the
  ET day. The halt is **sticky**: if equity later slips back under the line, the
  day stays banked — the goal is "make X% and stop", not "hover at X%". Exits,
  reconcile, the broker position sync, and paper trading are all unaffected.
- **The Monitoring card shows the goal** — day-start value, the bank line, and
  progress so far, with a "banked for the day" state once it's reached.
- **Behind the target, nothing presses.** Sizing stays exactly what the tune
  calibrated — the tracker never scales risk up to chase a shortfall, because
  escalating into a losing day is how accounts die. If days chronically fall short,
  the honest levers are a lower target or a band with more trade flow.
- **Reset to moderate disarms it** (it declares no goal, writing `null`), and so
  does clearing the field by hand. Configs from before this feature have no stored
  target, so nothing changes until a tune is applied once.

### The give-back guard — keep most of an almost-banked day

The banked-day halt only protects days that actually **reach** the target. The day it
protects least is the one that _almost_ made it: up +2.9% of a 3% goal, the loop keeps
opening entries on the way back down, and nothing stops the whole gain from
round-tripping (the drawdown halts all measure **losses from zero**, not give-back
from a high). Two config levels close that gap, both on the same day-gain axis as the
target and stamped by every Apply at **2/3** and **1/3** of it (a 3% target stamps arm
2% / floor 1%):

- **Arm** (`giveBackArmPct`) — once the day's gain has touched this level, the guard
  arms. Arming is sticky and silent (the Monitoring card shows "guard armed"; no
  journal entry).
- **Floor** (`giveBackFloorPct`) — if an **armed** day's gain then falls back to this
  level or below, new live entries and scale-ins halt for the rest of the ET day,
  exactly like a reached target: one `daily_give_back_halted` entry in Recent
  activity, sticky until the next ET day, exits/reconcile/sync/paper unaffected.

Arm-then-floor rather than a plain equity trailing stop, so ordinary morning chop
below the arm level can never lock the day out before it had a gain worth protecting.
The floor cannot be negative — below water, the daily-loss halts already own the day.
The guard runs only when **both** levels are set and coherent (`arm > floor ≥ 0`);
clearing either turns it off, and reset-to-moderate clears both along with the goal.

### Finish-line discipline — reduce the chance of the fade

The guard above reacts _after_ an almost-banked day fades; two optional companion
rules (2026-08-22, both off by default, both live-only) reduce the chance of the fade
in the first place:

- **Finish-line sizing** (`finishLineSizingEnabled`) — at +2.5% of a 3% goal, the next
  entry doesn't need full risk: a full-size winner would overshoot the target while a
  full-size loser gives back a third of the day. When the remaining gap to the bank
  line is smaller than a full-size winner's expected payoff (risk × the trade's reward
  multiple — the equity target R, or the options take-profit %), the entry's risk is
  trimmed so its win lands the day roughly at the goal. Floored at **quarter size** so
  the closing trade stays viable, and it **never sizes up** — behind the target the
  tune's calibration stands, because pressing into a shortfall is the classic path to
  ruin. The trim shows as the `finish_line_sizing` line in each entry's risk-check.
- **Armed-day selectivity** (`finishLineMinSignalScore`) — while the give-back guard
  is **armed**, new live entries must clear this signal score instead of the everyday
  `minSignalScore`: the trades most likely to give an almost-banked day back are held
  to the highest conviction bar. 0 disables; it rides the guard's arm flag, so it
  needs the guard levels set. Skips journal once per symbol per day
  (`finish_line_skipped`).

### Setting the goal by hand — the Daily goal card (2026-09-07)

Until 2026-09-07 the three fields above (`targetDailyGainPct`, `giveBackArmPct`,
`giveBackFloorPct`) could only be written by **Apply** — which also re-stamps the other
~35 tuned fields (max trades/day, the conviction floor, every exposure cap, the options
selection) to the band's values. Moving the goal by a point meant re-applying all of
that, so in practice the goal was set once and left where ambition put it.

The **Daily goal** card (right below the tune card) edits the three fields on their
own:

- **Daily gain goal %** — blank disarms the tracker _and_ the guard.
- **Give-back arm %** and **Give-back floor %** — the guard's two levels. **Stamp
  levels from goal** fills them at the tune's own 2/3 and 1/3 ratio; you can also type
  any pair.
- **Save daily goal** writes exactly these three fields; **Clear all** writes `null`
  to all three (the same disarm **Reset to moderate** performs, without touching any
  other setting).

The server validates the **merged** triple and refuses an incoherent one with a 400
rather than storing it: the arm must be **strictly above** the floor (floor ≥ 0), and
the arm must sit **below** the goal — otherwise the day would bank before the guard
could arm. The check runs against the stored values too, so a save that moves only
one side of a pair cannot invert it against the other. This matters because an
inverted pair does not fail anywhere at runtime: the tracker simply reads it as
"guard unconfigured" and the day runs with **no** give-back protection while the config
reads as if it had one. Guard levels saved without a goal are stored but do nothing
(the card says so) — the tracker only runs while a goal is set.

> Same framing as everywhere else in this app: the goal is a **discipline
> mechanism**, not a prediction. No gain is guaranteed — the tracker decides when to
> *stop*, never whether the market will get you there.

## 6b. The daily goal — what the record says

Everything in §6a is a **stopping rule on a level**, and until 2026-09-07 the level came
from ambition. The live book's realized edge at the time was ≈ +0.05R per trade at ≈ 9
entries a session and 1.25% risk — an expected day of roughly **0.5–1.4%** — against a
stored **3%** goal with its 2%/1% guard levels. Set that far above the distribution of
days the loop actually produces, the goal never banked, the guard never armed, the
finish-line trim never trimmed: the whole day-level protective stack was inert. That is
the same finding `docs/AUTOTRADING_SPEC.md` records at trade level on 2026-09-03 ("the
protective stack sat above the distribution"), one level up — and the remedy is the
same: a counterfactual over the realized record, not a guess.

### The sweep

The **Daily goal** card's **What the record says** panel replays each recent trading
session of a book under a stopping rule at a grid of levels:

- **Axis: R per session.** A strategy fact (position-derived series carry no deposits,
  withdrawals or manual trading — the tuning plan's data-quality rule) and the unit the
  auto-tune guard already judges in. Each level is also shown as **% of equity at full
  size** (`level × riskPerTradePct`), and the stored goal is put on the grid at
  `targetDailyGainPct ÷ riskPerTradePct` and highlighted.
- **Sessions come from the trading calendar** (the same `isTradingSession` the symbol
  cooldown counts with): a weekend or holiday is never a day; an event dated on one is
  attached to the previous session. The window is the last _N_ **completed** sessions
  ending at the book's last exit (default 40, 5–250, a request parameter — a lookback
  stored in config would be a field read by nothing). **Only active sessions count** —
  sessions with at least one entry. An idle session cannot be changed by any stopping
  rule, so it carries no information about one; counting it as a zero-change day would
  only shrink the interval. The first production read (2026-09-07) had 26 of the live
  book's 40 sessions idle, and did exactly that. Idle sessions are reported beside the
  table and excluded from every statistic in it.
- **Each trade is an entry moment, an exit moment and a realized R** from the helper its
  book already uses everywhere (`realizedPnlOf ÷ initialRiskOf` for the journal,
  `liveOptionsPnl ÷ riskAmount`, `paperRealizedR`). A trade that cannot be placed or
  scored — undated, no initial stop, no exit — is **dropped and counted**, never guessed.
- **Three policies**, per level, against the record as it happened (`none`):

  | Policy | Rule |
  | --- | --- |
  | **Bank the day** | halt new entries once cumulative R reaches the level (sticky, like production) |
  | **Bank + give-back guard** | today's stack: bank, plus the guard armed at 2/3 of the level and firing at a fade to 1/3 of it — only on an armed, not-yet-banked day |
  | **Bank + trail** _(not built)_ | keep entering **past** the level; halt only once the day fades back below it (guard as above). Measured here so it is built only if the record says so — rule D5 |

  A trade **entered after** the halt is dropped — none of its later events count. A trade
  already open at the halt runs to its **real** exit (the loop never closes on a bank;
  only new risk stops).
- **Per level and policy:** sessions halted, entries dropped, total / mean / median /
  worst day R, and the **mean per-session delta against the record** with a bootstrap
  95% confidence interval and a sign-flip p-value (the same `computeSignificanceStats`
  the backtest's significance panel uses, fed the per-session differences). `reliable`
  is the realized edge's own floors: **20 R-scored trades and 20 sessions** — forty
  empty sessions must not read as a reliable sweep of nothing.
- **Use this level** fills the goal at the level's % and stamps the guard at 2/3 and
  1/3 of it into the fields above. It **does not save** — a human presses Save.

### What is deliberately not modelled

Say it beside the table, not only here:

- **The unrealized intraday path.** Production banks on synced net liquidation
  _including_ open P&L and manual trades; the replay sees realized R only, so it touches
  every line **later** than the real day would — a lower bound on how often the stack
  engages.
- The two-tick confirmation and the cash-flow re-basing.
- The seven sizing multipliers and probation — the % column assumes full-size trades; the
  R axis is the truth.
- Finish-line sizing, the armed-day score bar and the day-protective stop — the replay
  keeps or drops whole trades, it never resizes or re-stops them.
- Options R is premium-based; a partial exit's slice lands at the final exit; a
  journal exit's moment is the reconcile wall clock (at most a tick late, approximated
  to the close of its date when the two disagree — counted).

### Pre-committed decision rules — when the stored goal moves

Same posture as `docs/OPTIONS_TUNING_PLAN.md`: decide the rules **before** seeing the
data, and treat "no change" as a result.

| # | Trigger | Min sample | Response |
| --- | --- | --- | --- |
| D1 | Any read of the sweep | — | **No goal change below 20 active sessions** (the `reliable` flag: 20 R-scored trades AND 20 sessions the book traded on). Report the shape and stop. |
| D2 | A level's per-session delta CI (rounded, as `checkOosEdgeConfirmation` rounds) **excludes zero** AND its neighbouring levels agree in sign | 20 sessions | Move the stored goal to that level — a **plateau**, never a spike. Stamp the guard at 2/3 and 1/3 unless the give-back column says otherwise. |
| D3 | A goal change under D2 | — | **At most one goal change per two weeks**, logged below with the sweep's numbers. Two changes make both uninterpretable. |
| D4 | A single day overshoots the goal by a lot | — | **Never raise the goal because one day overshot.** One day is not a distribution. |
| D5 | **Bank + trail** beats **Bank** at the stored level with a CI excluding zero, over ≥ 20 active sessions, on two consecutive reads a week apart | 20 active sessions | That is the trigger to **build** the trail mode (`dailyTargetReachedMode`, Phase 2) — never to hand-simulate it. Until then the column is evidence only. |
| D6 | The realized edge reads **≤ 0R** on a reliable record | 20 trades | The record supports **no** goal. Do not lower the goal to "make it reachable" — the fix is on the entry side (`liveMinSignalScore`, the entry-component work), not in the stopping rule. |

### Goal decision log

Append-only. Every change to `targetDailyGainPct` / `giveBackArmPct` / `giveBackFloorPct`
goes here, whether from a rule above or a direct instruction.

| Date | Change | Trigger | Evidence | Expected effect | Outcome |
| --- | --- | --- | --- | --- | --- |
| 2026-09-07 | **None.** Baseline recorded from the deployed config: goal **3%**, arm **2%**, floor **1%**, at 1.25% risk on $5,192 equity — set from ambition on 2026-08-21 | First read of the sweep on the deployed book, the day §6b shipped | **Live, last 40 sessions (2026-07-13 … 09-04):** 70 trades scored, 18 dropped (undated / stopless rows from before adoption stamping), avg R **−0.012**, the book traded on **14 of 40** sessions, actual −0.87R total, worst day −3.31R. The stored goal's row (2.4R) banked 2 sessions for +0.05R/session, CI 0.00 … +0.16; every bank level 0.5–3.5R read +0.05 … +0.07 with the CI's low end exactly 0.00; bank + trail ≈ 0 everywhere. **Paper (control):** 83 trades, avg R +0.023, +1.92R total; banking early **costs** it (−0.06 … −0.08R/session at 0.5–1.5R), and bank + trail at 1.5R is **−0.14R, CI −0.31 … −0.01** — the one interval in either book that excludes zero, on the wrong side. The tune's realized basis refused: "not positive" | D2 does not fire (no positive interval excludes zero; the control argues against lowering), D5 does not fire (trailing never beat banking), **D6 fires**: the live edge is ≤ 0 on a reliable trade count, so the record supports no goal — the fix is on the entry side. The goal stays at 3 / 2 / 1, which cost nothing on this record. This read also showed that a median over all 40 sessions reads 0 entries/session when the book is idle on 26 of them: the unit became the **active** session the same day, under which the live book has 14 — below D1's floor, the cleaner statement of the same conclusion | Re-read once 20 active sessions under the 72 conviction floor (armed 2026-09-06) are in the window — nothing from that regime is in this one |
| 2026-09-12 | **Sizing turned up by direct instruction**: `riskPerTradePct` 1.25 → **2.5**, `liveMaxExposurePct` 155 → **190**, `maxAggregateOpenRiskPct` 6 → **7.5**, `maxDailyDrawdownPct` 6.42 → **7.5**, `expectancyMaxMultiplier` 1.5 → **1.25**, `liveScaleOutEnabled` → **false**, `targetRMultiple` 2 → **1**, `stagnationExitMinutes` 90 → **60**, `symbolReentryCooldownMinutes` 120 → **390**, `autoTuneEnabled` → **false**, `mlRegimeEnabled` → **true** (cut 50 / tighten 15). Goal itself unchanged at 3 / 2 / 1 | Operator's decision: strive for the 3% daily gain now, accepting more risk, with the safety nets loosened rather than removed | The goal's height in R is `target% ÷ risk%`, so this halves it from **2.4R to 1.2R** — and the sweep counts +1.2R days about one active session in four against +2.4R on one in sixteen. The deployed goal-rate line confirmed it the same evening: **1.20R, reached on 4 of 16 active sessions (25%)**. Exit geometry is not the lever (twelve stop/target shapes all replay `inside_noise` at 0.06R on 69 paired trades), but a 1R target fills far more often at the same mean, so the slot turns over. The tuner is off for the trial because it walks a hand-set risk back down a quarter point a day, unconditionally | Expected day rises from ~0.1% to ~0.9% if the bank-at-1R shape holds; ~1 in 4 active sessions reach the goal; the worst recorded day (−3.3R) is −8% at the new size, against a halt at −7.5% | **Pre-committed review at 10 active sessions** (Decision 7): revert if the mean day is negative or the halt trips twice in any 5 sessions; keep if the goal rate ≥ 15% of active sessions and the mean day is positive; re-read at 20 either way. Decision 9's yardsticks travel with it: mean red day ≤ −1.5%, no day past the halt, no red day driven by an execution failure |
| 2026-09-12 (same day, after the first scan) | **No change. `symbolReentryCooldownMinutes` stays at 390**, now on judgment rather than on a measured leak | The first deployed run of the edge-leak scan disagreed with this plan's own pre-committed reading | The plan set the cooldown on a hand analysis reading live round 2 at −$185 over 20 trades with paper round 2 at −0.01R over 12 — both books negative. The scan, over 40 sessions on 2026-09-12, reads live round 2 **n=23, −0.24R, −$132.08, CI [−0.65, +0.10]** and paper round 2 **n=25, +0.04R**. Two of the bar's three tests fail: the live interval straddles zero, and the paper CONTROL now disagrees in sign — the paper sample doubled (12 → 25) and flipped positive. Under the scan's own logic "loses live, not in paper" is an EXECUTION pattern, not a decision one | The rule is kept: round 1 carries the book's entire P&L (+$107 over 73) while round 2 is −$132 over 23, and being wrong costs foregone re-entries rather than given-back gains. But it is recorded here as a judgment call, so the 10-session review does not mistake it for a demonstrated edge | **This row exists because the pre-commitment was wrong and said so.** The scan was written with "if it does not report round 2 as a leak, the scan is wrong, not the record" — on the evidence, the record moved and the scan is right. Re-read round 2 at the 10-session review; if the live bucket's interval has cleared zero with paper agreeing, it becomes a leak with a lever and the rule stops being judgment |

## 6c. When the regime overlay fires — the goal is held constant in R

The goal is `expected day % = entries/session × risk % × avg R`, and the tune solved
`riskPerTradePct` from it for a calm day. On a day the regime cut fires (the ML regime
overlay reading High Volatility/Bearish, a shock day, or SPY ATR above its threshold —
`docs/AUTOTRADE_RISK_SETTINGS.md`, "Regime size cut"), every new entry's risk is cut by a
factor _f_ (0.65 at the default 35% cut). A % goal left where it was would then be _1/f_
harder **in R** — reachable only through more entries, in the one regime where more entries
is the wrong answer — and the bank line and the guard's arm would come later or never.

So the day's **goal, arm and floor are all scaled by that same _f_**, from the same
`regimeTriggers` call the sizer uses (the loop derives the factor once per tick and hands it
to both): 3 / 2 / 1 reads **1.95 / 1.3 / 0.65** at a 35% cut. The identity holds on both
kinds of day — `entries × (risk × f) × avg R = f × goal` — so every mechanism keeps its
meaning at the scaled line: bank-the-day banks there, the finish line trims toward it, the
give-back guard protects the scaled floor, and the day-protective stop protects that same
floor (it reads the day's status now, not the raw config value). The goal card shows both
numbers ("1.95% = 3% × 0.65") and the trigger behind them; `daily_goal_scaled` journals each
change; `daily_target_reached` and `daily_give_back_halted` carry the scale.

**What freezes, and when.** The scale follows the reading per in-session tick — a mid-morning
data update or a regime switch before the day has a gain to protect is harmless and keeps the
goal consistent with the cut on every entry — until the guard **arms** or the day **banks**.
From then on the row is locked (the goal card says so): the bank line and the floor must not
move under a gain that has already touched them, and a switch changes tomorrow's goal, not
today's. The freeze is derived from the two sticky timestamps the baseline row already
carries, not a third flag.

**What is deliberately unchanged.** The target tighten does **not** scale the goal: it changes
the R distribution (smaller wins, more of them), which the walk-forward grid measures rather
than assumes. A skip (a cut of 100%) opens nothing, so it does not scale the goal either — a
day with no entries must not bank at +0%. The tune, the goal evidence, the `/tune/preview`
identity and the sweep are scale-invariant (they work in R or in ratios of configured
numbers), and `targetDailyGainPct` itself never moves — the scale lives on the day's baseline
row and clears on the day roll. Paper has no goal. The overlay ships off, so an untouched
config reads exactly as before.

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
- **The target is N× your expected day** (2026-09-07). Your realized edge at the tuned
  sizing produces a much smaller day than the target — the bank line and the give-back
  levels stamped from it will rarely engage. Shown past 2×, on a reliable record.
- **No edge in the record.** A reliable record whose average R is ≤ 0 supports no daily
  target; the preview says so instead of pretending a sizing exists that reaches one.

## 8. Caveats — read this

- **It is not derived from a proven edge.** Unlike the Journal's Kelly suggestion (which
  comes from your _realized_ win rate and payoff), this sizes from _ambition_. It will
  size up to chase a target your system may never actually hit.
- **Higher target = bigger swings both ways.** The daily-drawdown halt it sets is the
  amount you're accepting you might lose on a bad day in exchange for a shot at the good
  one. Look at that number before you apply.
- **The Expected-day basis assumes a 45% win rate**, not your history. If your real win
  rate is lower, that sizing is _more_ aggressive than it looks — which is what the
  evidence line under the preview and the **Realized** basis exist to show you. On the
  live book at the time this shipped the realized edge was ≈ +0.05R per trade against
  the ≈ 0.35R that assumption implies.
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
