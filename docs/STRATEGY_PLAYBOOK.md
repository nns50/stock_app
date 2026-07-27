# Strategy Playbook

How to use **stock-app** to trade more profitably.

A blunt truth first: **no app predicts the market, and this one explicitly doesn't
try.** What separates traders who keep their money from those who don't is rarely a
secret indicator — it's **process**: controlling risk, taking only trades with a real
edge, exiting with discipline, and reviewing honestly. This app is built to give you
that process edge. Every strategy below is a *repeatable workflow* you drive with the
app's tools, not a "buy signal."

> New here? Read the **[User Guide](./USER_GUIDE.md)** first so the page/feature names
> below make sense.

---

## Contents

1. [The five disciplines that actually make money](#the-five-disciplines-that-actually-make-money)
2. [Position sizing, worked out](#position-sizing-worked-out)
3. [Playbook A — Momentum/trend swing (long)](#playbook-a--momentumtrend-swing-long)
4. [Playbook B — Mean-reversion fade (short)](#playbook-b--mean-reversion-fade-short)
5. [Playbook C — Directional options (long calls/puts)](#playbook-c--directional-options-long-callsputs)
6. [Validating an edge with the Edge Report](#validating-an-edge-with-the-edge-report)
7. [Is a backtested edge real, or noise?](#is-a-backtested-edge-real-or-noise)
8. [Is it a real edge, or a lucky setting? — the parameter sweep](#is-it-a-real-edge-or-a-lucky-setting--the-parameter-sweep)
9. [Tuning stops & targets with MAE/MFE](#tuning-stops--targets-with-maemfe)
10. [Reducing slippage with execution quality](#reducing-slippage-with-execution-quality)
11. [Guardrails: risk of ruin & the benchmark](#guardrails-risk-of-ruin--the-benchmark)
12. [The weekly review checklist](#the-weekly-review-checklist)
13. [Anti-patterns to avoid](#anti-patterns-to-avoid)

---

## The five disciplines that actually make money

These are the habits the app is designed to enforce. Master them and the strategies
take care of themselves.

### 1. Risk a fixed, small fraction per trade ("1R")

Decide once what **1R** is — the dollar amount you'll risk on any single idea — and
make every trade risk that same amount. A common, survivable choice is **0.5%–1.5% of
the account per trade**. The **Size by risk** tool turns that into a share/contract
count automatically. Fixed fractional risk is the single most important reason a
strategy with a real edge actually compounds instead of blowing up.

### 2. Always log a stop

A trade without a predefined stop can't be sized, can't be measured in **R**, and can't
appear in your **R-multiple analytics**, **risk of ruin**, or **MAE/MFE**. Setting the
stop in the log form also arms the **stop-hit** exit alert. *No stop, no trade.*

### 3. Take only trades with a positive expectancy

You don't need to win often — you need your **expectancy** (`winRate×avgWin −
lossRate×avgLoss`) to be positive. A 40%-win system with 2.5R winners and 1R losers is
excellent. The Journal shows your real expectancy and **profit factor**; let them, not
your feelings, tell you if a setup works.

### 4. Exit by rule, not by emotion

Define the exit *before* you enter: a **stop**, a **target**, and for options a
**take-profit / stop-loss / time-exit**. Let the app's **exit alerts** and **option
exit-rules engine** tell you when a line is crossed. Most account damage comes from
moving stops and "hoping."

For options specifically, set an **option-contract alert** (Alerts → Option) on the
exact call/put you care about — trigger on the **underlying price**, the contract's
**mark / bid / ask**, **|Δ|**, or **IV**. Give it a **role**: an **entry** alert flags a
good entry *and auto-attaches a suggested exit* (your take-profit / stop / time rule) so
the signal arrives with the exit already decided; an **exit** alert watches a contract
you hold. From **Options → Entry scan**, the **＋ Alert** button turns a ranked contract
into that entry alert in one click, with a strategy note pre-filled. The discipline win
isn't the entry — it's that *you never enter without a written exit.*

### 5. Review on a cadence

Edge decays and habits drift. The **Edge Report**, **by-tag/by-grade/by-discipline**
breakdowns, **drawdown**, and **alpha vs SPY** exist so you can prune what doesn't work
and double down on what does. A trade you don't journal is a lesson you paid for and
threw away. Auto-traded entries are now graded automatically — **A/B/C from the screener
score** (thresholds in Config → risk settings) — so the **by-grade** breakdown answers a
concrete question for the loop: do your A-grade (high-conviction) setups actually out-earn
the B/C ones? If they don't, the conviction score isn't measuring edge, and any plan to size
up on it is premature.

---

## Position sizing, worked out

This is the math behind **Size by risk**, so you can trust it.

```
riskPerUnit   = |entry − stop| × multiplier      (multiplier = 1 stock, 100 option)
maxRiskDollars = accountSize × (risk% / 100)
suggestedQty  = floor( maxRiskDollars ÷ riskPerUnit )
```

**Stock example** — $25,000 account, risk 1% (= $250), buy at $200 with a stop at $192:

```
riskPerUnit    = |200 − 192| × 1   = $8 per share
maxRiskDollars = 25,000 × 0.01     = $250
suggestedQty   = floor(250 ÷ 8)    = 31 shares
```

If the stop hits, you lose ≈ $248 — your 1R — regardless of the stock's price. Tighten
the stop to $196 and you can size **62 shares** for the *same* risk; widen it and you
size smaller. **The stop distance, not your conviction, sets the size.**

**Option example** — same $250 risk, a call bought at $8.50 with a plan to cut at
$5.00:

```
riskPerUnit    = |8.50 − 5.00| × 100 = $350 per contract
suggestedQty   = floor(250 ÷ 350)    = 0 contracts → the app warns you
```

The warning is the point: this contract risks more than 1R for a single unit. Choose a
cheaper contract, a tighter exit, or accept it's too big — but do it *knowingly*.

**Defined-risk spreads** (verticals) have no price stop — their loss is _capped by the
structure_, so the calculator's **Vertical spread** mode sizes by **max loss per spread**
instead of a stop distance:

```
maxLossPerSpread = (direction = debit ? netDebit : width − netCredit) × 100
suggestedSpreads = floor( maxRiskDollars ÷ maxLossPerSpread )
```

**Spread example** — same $250 risk, a $5-wide call debit spread bought for a **$2.00**
net debit:

```
maxLossPerSpread = 2.00 × 100      = $200 per spread   (also the cash you pay)
suggestedSpreads = floor(250 ÷ 200) = 1 spread
```

Max profit is `(width − netDebit) × 100 = $300`, a **1.5 : 1** reward:risk. A credit
spread flips the math — you keep the credit as max profit and risk `width − credit`. The
**capital tied up equals the max loss** either way (the debit you pay, or the collateral a
credit holds), so 1R discipline still applies — the spread just defines the "stop" for you.

**Sizing from your own edge.** Once you have ~20+ decisive closed trades, the Journal's
**Kelly suggestion** proposes a risk % from your realized win rate and payoff ratio.
The app deliberately returns a **quarter-Kelly, capped at 3%** — full Kelly is wildly
volatile and assumes your edge is exact. Treat it as a ceiling, not a target.

Auto-Trade's **Auto-tune from realized edge** (Config tab, off by default) closes this
loop for you: once enabled, it re-reads this same Kelly suggestion once a day and nudges
`riskPerTradePct` toward it — bounded by a configurable max daily step so one noisy day
can't swing live sizing, and gated on the same minimum-sample-size floor. Every adjustment
is journaled to Recent Activity and pushed as a notification through your configured
webhooks, same as the other consequential loop events. It's still worth checking the
Journal's own Kelly panel periodically — auto-tune only ever moves *toward* it a little
at a time, it doesn't replace understanding where the number comes from.

A separate **Also auto-tune exit geometry** toggle (off by default, independent of the
risk-% tune) does the same thing for your **stop and target** using the
[MAE/MFE](#tuning-stops--targets-with-maemfe) math below: once a day it reads the excursion
of your _winning_ autotrade trades and nudges `stopAtrMultiple` toward the heat a good trade
actually takes (plus a buffer) and `targetRMultiple` toward how far a good trade actually
runs — winners only, since a stopped-out loser's drawdown is censored at the stop and can't
tell you whether a wider or tighter one was better. Bounded by its own max daily step, and
journaled/notified the same way. Same caveat as the risk-% tune: it moves toward the reading
a little at a time and never replaces reading the MAE/MFE report yourself.

Did a past adjustment actually help? The Journal page's **Auto-tune efficacy** card
answers that directly — before/after win rate and expectancy around each adjustment's
own date. Deliberately informational only: it never auto-reverts a change that looks
bad in hindsight, for the same reason auto-tune itself waits for a real sample before
acting on a Kelly reading in the first place — judging "did this help" off however few
trades have closed since a *recent* change would be pure noise-chasing, and telling a
genuinely bad adjustment apart from an unrelated cold streak or regime shift is
genuinely hard even with a full sample. You stay in the loop; the system never
silently walks its own sizing back on your behalf.

**Sizing from ambition, not edge — "Tune from target daily gain."** The two tools above
size from what your edge _has done_. Auto-Trade's **Tune from target** (Config tab, 2026-07-23)
goes the other way: you name a **target daily gain %**, and it back-solves the per-trade
risk (and loosens the exposure caps, filters, and options selection to match) so that
target is _reachable_. Two honest framings share one formula,
`riskPerTradePct = target ÷ (tradesPerDay × edgeR)`: on the **Expected** basis, `edgeR` is
your average R per trade (assuming ~45% win at the band's reward:risk), so the target is
your _average_ day; on the **Perfect-day** basis, `edgeR = R`, so the target is the
_ceiling_ you'd hit only if every trade wins. The same 5%/day target implies **~2.4%**
risk on the first basis and **~0.4%** on the second — the toggle is you choosing which
assumption to bet the account on. This is a legitimate way to set an aggressive posture
_deliberately_, but respect what it is: unlike Kelly, it is **not** derived from a proven
edge — it will happily size up to chase a number your system may not actually produce.
The higher the target, the faster a losing streak compounds; the tool caps its own
_suggestion_ and warns loudly past a survivable per-trade risk, but it won't stop you
hand-entering more. Preview every changed field, and remember the daily-drawdown halt it
sets is the number you have to be willing to lose on a bad day to have a shot at the good one.

**A softer brake than the daily halt.** The daily-drawdown halt is all-or-nothing — full
size until a hard floor, then nothing. **Equity-curve de-risking** (Config → risk settings,
off by default) is the graduated version, keyed to your own results rather than the clock:
it tracks the strategy's cumulative closed-P&L curve (paper and live kept separate) and,
whenever the latest point sits below its N-day moving average, cuts new-position size by a
set %, restoring full size once the curve climbs back above the average. It's the classic
"trade your equity curve like a price series" filter — you keep trading through a rough
patch, just smaller, which blunts the string of full-size losses a drawdown can inflict
without the whiplash of a hard stop. It stacks multiplicatively with step-down and regime
sizing, and like them applies to paper and live only, not backtests.

**Don't size bigger than you can exit.** Risk-based sizing only looks at your stop
distance, not the stock's liquidity — so a tight stop on a thin name can hand you a
position that takes days to unwind without moving the price against yourself. **Max ADV
participation (%)** (Config → risk settings, 0 = off) caps any single equity position at
that percent of the name's ~20-day average daily volume. A small cap (1–3%) keeps you in
liquid territory; it binds only on thin names or oversized budgets, and silently skips
when a name's volume can't be resolved rather than blocking the trade. Options are exempt
(they already screen on open-interest and volume floors).

**Let the edge you've measured set the size.** The by-grade Edge Report answers whether your
A-grade setups actually out-earn your C-grade ones; **expectancy-weighted sizing** (Config →
risk settings, off by default) is what acts on that answer instead of leaving it on a chart.
When it's on, each conviction grade is sized by its _own_ realized edge — a grade whose closed
trades average a positive R risks more, a grade that bleeds risks less, breakeven stays flat
(multiplier = 1 + average R, clamped to the min/max bounds you set, e.g. 0.5×–1.5×). This is
the disciplined version of "add to what's working": it only sizes up a grade once that grade
has _earned_ it in your own results, and only within a bound you chose in advance — no
single grade can run away with the book, and the aggregate-risk cap still binds on top. Two
guardrails keep it honest. First, a grade with fewer than your **expectancy min sample** closed
trades stays neutral at 1×, so a lucky handful of early wins can't inflate size before the
sample means anything — set this to the number of trades you'd want before trusting a per-setup
win rate (10–20 is reasonable). Second, paper and live are scored on separate books, so a paper
hot streak never sizes up real money. It stacks multiplicatively with step-down, regime, and
equity-curve sizing, and like them is live + paper only, with no backtest equivalent — prove a
grade's edge in the by-grade report first, then let this size to it.

---

## Scaling into winners (pyramiding)

The five disciplines above size the trade **once, at entry**. Scaling in is the opposite
move — **adding to a position that's already working** — and it's the one technique here
that _adds_ risk after the fact, so it earns its own rules. The Auto-Trade config exposes
it with a **scale-in trigger** in R, a **scale-in size** as a % of the current position, and
a **max add-ons** cap. It runs in **paper and backtest** by default; a separate, off-by-
default **live** toggle (below) extends the exact same rules to real positions once you've
validated them.

Why it can help: a trend that pays 3–5R rewards a bigger position through the fat part of
the move, and adding _only after_ the trade proves itself keeps your initial risk small.
Why it usually hurts beginners: adds raise your average entry, so a normal pullback can
turn a green trade red, and an uncapped pyramid quietly becomes a huge undiversified bet
right before the reversal. The implementation defends against both — each add **blends the
entry** and immediately **raises the stop to 1R below the new blended entry** (so the whole
larger position still risks about 1R), and **max add-ons** hard-caps the pyramid. The
R-multiple that triggers the next add is measured from the _blended_ entry, so adds
naturally space out ~1R apart instead of piling on at one price.

Rules of thumb: keep add size **≤ the original** (a 100% → 50% → 25% taper, not the
reverse), cap add-ons at **1–3**, and **never** scale into a mean-reversion fade — pyramiding
belongs to trends, where being wrong shows up fast as a stop-out, not to a fade that "should"
turn around. Above all: **prove it in the backtester first.** Run the same window with the
scale-in fields off, then on, and compare — expectancy per _initial_ R, max drawdown, and
the R-standard-deviation. If pyramiding only lifts the average by widening the tails, you've
added variance, not edge. It shines exactly where discipline #4 (exit by rule) already holds.

**Taking it live.** Once the backtest and a paper run have convinced you, the live toggle
(**Auto-Trade → live-trading settings → "Scale into live winners"**, plus a **max live
add-ons** cap you can set below the paper one) applies the same rules to real positions. It's
**off by default** and gated behind live trading being enabled. Mechanically it's the safest
shape available: each add is placed as its **own bracket order** — the added shares are born
with their own protective stop (1R below the new blended entry) and the position's target,
so nothing is ever left un-stopped and your original bracket is never disturbed. One
consequence to know: your live position then rides **two stops** — the original shares at the
original stop, the added shares at the tighter raised stop — so a pullback stops the added
shares out first, protecting that newer profit, while the core keeps running. Start with
**max live add-ons = 1**, and treat the first few live adds as confirmation that the
broker-order path behaves before trusting it with more.

---

## Playbook A — Momentum/trend swing (long)

**Idea:** buy strength that's confirmed by trend and participation; ride it to a
measured target; cut quickly if it fails.

**Find it (Screener, long):**
- Run the screener and favor names where the score is carried by **Momentum**,
  **Trend** (price > 20MA > 50MA), and **Rel. Volume > 1** — expand the row and check
  the breakdown rather than trusting the headline number.
- Keep your hard filters honest (min price, min average volume) so you're not trading
  illiquid names.
- **Save a snapshot** so you can later confirm these picks actually moved.

**Plan it:**
- **Entry:** the level you'd act on (e.g. a breakout/retest).
- **Stop:** below the structure that would prove you wrong (a swing low, or below the
  20MA). This defines 1R.
- **Target:** a level giving at least **~2R** (use **MAE/MFE** history to set this
  realistically — see below).

**Execute it:**
- **Size by risk** to your 1R, run the **pre-trade checklist**, then **log the trade**
  with a tag like `momentum` or `breakout` and a grade for setup quality. Set the stop
  and target so the exit alerts watch it.

**Manage it:**
- Watch the row's **R** on the management line. Let **target-hit / stop-hit** alerts,
  not impulse, drive the exit. Consider scaling out part at ~1.5–2R and trailing the
  rest.

**Review it:** in the Journal, check the `momentum` tag's **expectancy** and the
**Edge Report** for these snapshots. Keep the setup only if the top tiers genuinely
outperform.

---

## Playbook B — Mean-reversion fade (short)

**Idea:** fade an over-extended move back toward the mean. Lower base rate, so risk
control matters even more.

**Find it (Screener, short):** flip the screener to **short**. The components mirror:
it now rewards downside momentum, an **RSI** near the short sweet-spot (~40 band), and
bearish trend alignment. Look for names stretched *against* a higher-timeframe level
you respect.

**Plan it:**
- **Entry:** into resistance / an exhaustion point.
- **Stop:** above the high that would invalidate the fade (for a short, the stop is
  *above* entry — the sizer warns you if you get this backwards). This is 1R.
- **Target:** the mean you're fading toward (e.g. the 20MA). Fades often have nearer
  targets, so insist the math still gives ≥ ~1.5R.

**Execute / manage / review:** same loop as Playbook A — size to 1R, checklist, log
with a `mean-reversion` tag, exit by rule. Because fades fail fast, the **stop-hit**
alert and a strict "one stop, no moving it" rule are doing the heavy lifting. Compare
the `mean-reversion` tag's expectancy to `momentum`; many traders find one clearly
suits them better — the Journal tells you which.

---

## Playbook C — Directional options (long calls/puts)

**Idea:** express a directional thesis with defined risk (you can only lose the
premium), while respecting that **time and volatility work against long options.**

**Pick the contract (Options → Entry scan):**
- Set your **side** (call/put) and a **delta band**. Delta ≈ probability of finishing
  ITM and how stock-like the option behaves: **~0.30 delta** is cheaper and more
  leveraged (lower base rate), **~0.60–0.70 delta** behaves more like stock with less
  theta drag. Pick to match your conviction and hold time.
- Demand **liquidity**: tight **max spread %**, a **min open interest/volume**. The
  scanner ranks candidates by **spread tightness, liquidity, and delta fit** — let it
  surface the cleanest contract.
- **Confirm the real spread before you commit.** The chain is delayed (~15 min); in
  **Options → Chain**, click the contract to overlay Webull's **live OPRA** bid/ask
  (with sizes) and re-check the true spread and top-of-book depth at the moment you'd
  trade. A spread that looks fine on delayed data can be materially wider live.
- Mind **IV rank.** Buying long premium when **IV rank is high** means you're paying up
  and exposed to an IV crush (e.g. after earnings). Prefer **low-to-moderate IV rank**
  for long options, or **switch structure instead of skipping the trade**: a debit
  spread's short leg sells back some of that rich premium, capping the cost (at the cost
  of capping the upside too). Running the automated loop? **Auto-Trade → Configuration →
  Options strategy → `Auto (by IV rank)`** makes exactly this call for you, per
  candidate, every cycle — debit spread once a candidate's IV rank reaches 50, single
  leg below that — instead of one structure locked in for every trade regardless of
  where premium actually sits that day.
- Give yourself **enough DTE** that time decay isn't brutal for your hold (swing trades
  generally want weeks, not days).

**Size & log:** the premium-at-risk math is the same — risk per contract is
`|entry − exit| × 100`. Size so total premium risk ≈ your 1R, then log the option
position (type/strike/expiration) with a stop and target.

**Exit by rule (Options → Exit rules):** configure **take-profit %**, **stop-loss %**,
and a **time-exit** N days before expiry (so you don't hold into accelerating theta /
pin risk). The engine flags which rule is live; the same logic feeds your exit alerts.
A simple, robust default: **take profit into strength, cut at your stop %, and never
hold a long option into the last few days unless it's deep ITM.**

**If auto-trading trades options for you, set its stop too.** Auto-Trade's **Options
stop-loss (%)** / **Options take-profit (%)** now apply to **live** positions as well
as paper (2026-07-26) — but they still default to **0/off**, which leaves the 7-DTE
time exit as a live position's only automated brake. A long option can lose its entire
premium long before expiry; a stop of 50% of premium (the manual exit-rules default)
with a take-profit around 50–100% is a sane starting shape. Whatever numbers you pick,
they're % of premium (net debit for a spread), and the Journal's exit-reason badges
will show you which rule is actually doing the closing.

**Considering a roll instead of closing outright? (Options → Strategy → Roll analyzer,
2026-07-23.)** A time-exit trigger, or an ITM short leg risking assignment, doesn't have
to mean flat — rolling to a later expiration (and often a different strike) keeps the
thesis alive. Before you do, run it through the roll analyzer: it shows the **net
debit/credit to roll** and, critically, whether the new contract's **probability of
profit and expected value actually improve** versus the one you hold — a later
expiration alone doesn't guarantee a better trade, and paying a large debit to roll a
structurally worse position is how a small loss becomes a chase.

**Watch the whole book, not just one contract.** Once you're running more than one
options position at a time, per-contract delta/theta only tells you about that one
trade — Auto-Trade's Dashboard tab has a **Portfolio Greeks** section that sums net
delta, theta, and vega across your WHOLE combined open options book (paper + live): a
single $ figure for "am I net long or short the market right now" and "how much am I
bleeding or collecting in time decay today." Two positions that each look fine in
isolation can still leave you far more directionally exposed, or bleeding far more
theta, than you'd guess from either one alone.

---

## Validating an edge with the Edge Report

A setup is only worth trading if it **outperforms**. The workflow:

1. **Save a snapshot** every time you run the screener with a configuration you care
   about.
2. After picks have had time to play out, open **Snapshots → Edge Report**.
3. Read the **by-rank-tier** table: your **top tier should out-return the bottom
   tier**. If it does, your scoring has edge — trade it and consider sizing the top
   tier a touch larger. If it doesn't, your weights are noise.
4. **Iterate the weights** in the screener config (e.g. lean harder on Trend + Rel.
   Volume, lighten Gap), snapshot again, and re-check. You're doing real, cheap
   research on *your* universe — no backtest framework required.

This loop — hypothesize → snapshot → measure forward returns → re-weight — is the
single highest-leverage thing the app enables.

**Then make the score bite.** Ranking is only half the job: without a floor, the
auto-trade loop will still take its 6 trades a day from whatever passed the raw
filters, even when the best available score is a 12. Once the Edge Report shows your
top tier genuinely outperforms, set **min signal score** (auto-trade config,
2026-07-26, 0 = off) so the loop simply sits out when nothing clears the bar — the
B-grade threshold (60 by default) is a sensible first floor. Fewer, better trades is
an edge in itself: every skipped low-conviction entry is commission, slippage, and a
risk-budget slot saved for a real one. Backtest the floor first via the screener-config
override if you want the number to be evidence rather than taste.

**One weight set may not fit every market.** The same weights that reward fresh trend
breakouts in a risk-on tape can chop you up in a risk-off one, where fading extremes pays
better. **Regime-adaptive scoring weights** (auto-trade config, off by default) lets the
loop carry three weight presets — risk-on, neutral, risk-off — and pick the one matching
the **market-regime gauge** at scoring time, so the strategy leans on trend/momentum when
risk is on and on RSI/mean-reversion when it's off. Don't guess the presets: use the Edge
Report loop above _within each regime_ to learn which weights actually earned in that
environment, then encode that. It's opt-in and the presets default to your standard
weights, so it changes nothing until you deliberately differentiate them — and like any
scoring change, prove it forward (or in a backtest) before trusting it live.

---

## Is a backtested edge real, or noise?

A walk-forward backtest's stat grid (Auto-Trade → Configuration → **Backtest &
walk-forward**) tells you *what happened* in the out-of-sample window — win rate,
expectancy, profit factor. It doesn't tell you *how much to trust* that number. A
positive expectancy over 12 trades and a positive expectancy over 200 trades are not
equally convincing, even if the dollar figure is identical.

Each walk-forward window also shows a **significance** panel answering that directly:

- **95% CI on expectancy** — bootstrap resampling: the range of average $/trade you'd
  plausibly see if this same window's trades played out again. A CI that stays
  entirely above zero is a good sign; one that straddles zero means "could easily have
  been a losing system too."
- **p-value vs. no edge** — a sign-flip permutation test: how often randomly
  re-signing this window's own wins and losses (simulating "no real directional edge")
  produces a mean at least this extreme. Conventionally, under 0.05 reads as unlikely
  to be pure noise — but treat that as a rule of thumb, not a law.
- **Sample size**, flagged once it drops below 20 trades — below that floor, both
  numbers above are themselves too noisy to lean on hard, the same way this app's own
  Kelly-sizing suggestion (Position sizing, above) flags itself unreliable under the
  same threshold.

Like the rest of this backtest tool, this renders no pass/fail verdict — it's evidence
you weigh alongside the in-sample/out-of-sample comparison itself, not a gate. A wide
CI or a p-value near 1 doesn't mean the config is bad; it means you don't yet have
enough out-of-sample data to tell. The fix is usually the same one that applies
anywhere sample size is thin: widen the date range, add more symbols, or keep paper
trading it a while longer before trusting the number.

The one place this exact test _does_ act as a gate is live: when **auto-tune** (Config →
auto-tune) is on, its **out-of-sample confirmation** guard (default on) runs this same
bootstrap CI over the recent half of your real closed trades before letting the Kelly
nudge _raise_ risk-per-trade — if that recent-half CI isn't entirely above zero, the
increase is held. It's the walk-forward discipline above, applied automatically to the
one decision where over-fitting your own history costs real money. Cuts are never gated.

---

## Is it a real edge, or a lucky setting? — the parameter sweep

The significance panel above answers "is this window's edge distinguishable from
noise." A related but different question: is the edge sensitive to the *exact* risk
setting you happened to pick, or would a nearby setting have worked about as well? A
config that only looks good at one precise value and falls apart half a point either
side was probably fit to that window's noise, not to a real, size-insensitive edge.

**Parameter sweep — risk per trade** (Auto-Trade → Configuration → Backtest &
walk-forward, below the equity walk-forward results) automates this check. Give it a
center **risk per trade %** and it reruns the same walk-forward split — same symbols,
dates, out-of-sample split, risk profile, equity, position cap, and direction — once
each at half, three-quarters, 1x, 1.25x, and 1.5x that center, and lays each run's
out-of-sample stats and significance side by side in one table, the center value's own
row marked.

Read it as a shape, not a single number:

- **A stable plateau** — expectancy, win rate, and return stay in the same ballpark
  across all five values, moving gradually as risk per trade scales — is what a real
  edge looks like. The strategy is finding genuinely good trades; how hard you press the
  size dial is a separate, secondary decision.
- **A lucky spike** — one value (often the center you already had in mind) looks
  dramatically better than its immediate neighbors, with no consistent trend — is a red
  flag for overfitting to that window's specific path, not a discovered edge. Widen the
  date range or add more symbols before trusting it.

Like everything else in this backtest tool, the sweep renders no verdict — it's one
more piece of evidence to weigh alongside the in-sample/out-of-sample comparison and the
significance stats above, not a pass/fail gate.

---

## Tuning stops & targets with MAE/MFE

Open **Journal → Analytics → Excursions** (closed stock trades). For each trade it
shows:

- **MAE** (Maximum Adverse Excursion) — the worst drawdown the trade reached before you
  exited, in **%** and **R**.
- **MFE** (Maximum Favorable Excursion) — the best unrealized profit it reached.

How to use it:

- **Winners with small MAE** → your stop could be **tighter** (you're risking more than
  you need to), letting you size larger for the same 1R.
- **Lots of MFE you didn't capture** → your **target is too close** or you're exiting
  early; consider trailing or a wider target.
- **Losers whose MAE blew well past 1R** → you're **moving or ignoring stops.** Fix the
  behavior, not the strategy.

Small, evidence-based adjustments here often improve expectancy more than any new
setup.

**Check the sample before you act on it.** The panel fetches daily candles per trade, so
it caps how many it does per request and can't measure a trade with no entry date or one
the provider has no data for. When any of that applies it says so above the table —
"averages over 12 of 70 closed stock trades" — and that line is the difference between
"my winners give back half their MFE" and "half of a twelfth of my winners did." Widening
a target on the second is a decision made from noise. If the excluded count is large,
treat the averages as a hint and read the individual rows instead.

---

## Reducing slippage with execution quality

Every live trade has two prices: the one you **intended** (your order's limit) and the
one you **got** (the broker's fill). The gap between them is slippage, and it's a
silent, recurring cost that never shows up in a strategy backtest. Open **Journal →
Analytics → Execution quality** to see it for every live-traded fill:

- **Total slippage $** across all fills, and the **average %** per fill — positive
  always means it cost you money, whichever side you were on.
- Each fill, **worst-first**, comparing its limit price to the actual fill.

How to use it:

- **A consistent positive bias on entries** usually means your limit is set too
  aggressively (at or through the ask) to guarantee a fill, effectively turning it into a
  market order. Give it a little room, or accept you're paying for certainty of fill.
- **Bad slippage concentrated in a few symbols/strikes** points at **thin liquidity** —
  check the spread and open interest before you commit size there again.
- **Near-zero slippage** across the board means your limit discipline is working — the
  numbers you sized and risk-assessed the trade with are the numbers you actually got.

Scope: this only covers orders **placed live through this app** with a limit price. A
stop-market fill has no reference price to compare against, and a manually logged or
imported trade was never a live order — neither shows up here, by design (there's
nothing honest to compare them to).

The same **Auto-tune from realized edge** setting mentioned above also watches this
per-symbol: once enabled, a symbol whose average live-fill slippage crosses a configurable
threshold (with enough fills to trust the reading) is automatically added to the
autotrade exclusion list — the same list Settings' manual exclusions use, so it's visible
and reversible there, not a hidden blocklist. A thin, hard-to-fill name that's quietly
bleeding money on every entry/exit stops being re-traded without you having to notice the
pattern in the Analytics tab yourself. Like the risk-% nudge above, an exclusion is both
journaled to Recent Activity and pushed as a notification, naming the symbol and the
slippage reading that triggered it.

---

## Guardrails: risk of ruin & the benchmark

Two questions every serious trader must keep answering:

**"Have I already lost enough today?" → Daily guardrails (Settings → dashboard).**
Set a **daily loss limit** and a **max-new-trades-per-day** cap. The Today dashboard
tracks your booked loss and trade count and turns red when you hit a limit — your cue to
close the laptop. Tilt and revenge-trading happen *after* a bad morning; a pre-committed
daily stop is the cheapest protection against turning a small red day into a disaster.

**"Can this kill my account?" → Risk of ruin (Journal → Analytics).**
Set your per-trade risk and a "ruin" drawdown threshold (say 30–50%); the Monte Carlo
sim runs thousands of trade sequences drawn from your edge and reports the **% that hit
ruin.** If that number is anything but tiny, **cut your risk % until it is.** Survival
first — you can't compound an edge from zero.

**"Is my trading even worth it? → You vs SPY (Journal).**
Your **alpha** is your realized return minus simply holding the index over the same
window. If alpha is persistently **negative**, the honest move is to trade smaller and
buy the index — and the app will have just saved you a lot of money. If it's
**positive and stable**, you've earned the right to keep going (and maybe scale).

**"What does a bad market day do to my whole book?" → Market stress test (Positions,
2026-07-23).** Beta-weights every open stock and option position against a fixed set of
hypothetical broad-market moves (±2/5/10%) and shows the estimated P&L for each — a quick
answer to "am I overexposed to a market-wide selloff, not just any one position?" It's a
sensitivity model built from each symbol's own historical beta, not a forecast; a position
whose beta, price, or delta can't be resolved is excluded and listed, not silently ignored.
If the −10% scenario would hurt more than you can stomach, that's a signal to trim gross
exposure or add a hedge — independent of what any single stop-loss says.

**"Am I holding one bet wearing three tickers?" → Correlation-aware selection (Config →
risk settings, 2026-07-24, off by default).** The autotrader approves candidates top-down
by score until a cap binds — so on a day when your three highest scorers all move as one
sector, the top two can fill your whole book and crowd out a genuinely different,
only-slightly-lower-scored name further down. The correlated-exposure cap catches the
extreme version after the fact; this catches it at selection. Turn it on and, before the
caps bind, the loop re-ranks the candidates: among names correlated at or above your
correlation threshold, the highest-scored keeps its rank and the redundant lower ones are
demoted to the back — so the diverse picks win the position and trade caps and your book
spreads across the edge instead of tripling down on one factor. It only reorders (it never
drops a candidate, and the correlated-exposure cap still binds as the backstop), so with a
book that isn't correlated it changes nothing. Because it's genuinely a selection change,
it runs in the **backtest** engines too — so you can measure whether de-crowding actually
improved your historical risk-adjusted return before enabling it live.

**"What happens when the app isn't sure?"** Worth knowing, because it shapes what you'll
see: every live-order decision made under an unknown resolves toward **doing less**, not
toward assuming the convenient answer. A fill the app can't fully account for is booked
**short** rather than invented. A placement the broker never answered is left **unresolved
and pollable** rather than declared rejected — so don't re-place it until it settles. A
force-close that can't confirm the position's resting stop is actually gone **doesn't
place**, because a close sitting next to a live stop can fill twice and leave a long
short. An option that expired **in the money** is left open and flagged rather than booked
at a guessed price, because it was exercised into stock the app doesn't track. And a live
position the broker shows **no resting stop** for is reported, never silently re-armed —
a replacement placed on a check that merely failed to *see* the original would leave two
stops on one position and sell it twice.

The practical consequence for you: an app that occasionally says "I couldn't
confirm this, so I did nothing" is working as intended, and those messages are worth
reading rather than clicking past — each one means your records and your broker might
disagree, and the fix is to look at the broker, not to retry. The one that should never
wait is **"no resting stop"**: that is a live position with no downside protection, and
it needs you at the broker now, not at the next review.

---

## The weekly review checklist

Spend 20 minutes every weekend in the **Journal**:

- [ ] **Equity curve & drawdown** — trending up? Currently in a drawdown? How deep vs
      your max?
- [ ] **Edge over time** — is the rolling expectancy holding up, or quietly decaying?
      A fading line is your cue to trade smaller and figure out what changed.
- [ ] **Expectancy & profit factor** — still positive? Trending which way?
- [ ] **SQN (System Quality Number)** — is your edge strong *and* consistent? Below ~2
      means the system is hard to trade at size; aim to push it up by tightening
      losers (lower R std-dev) more than by chasing bigger winners.
- [ ] **By tag** — which setups earn? Drop or shrink the losers.
- [ ] **By timing** — any weekday or hold-length you're consistently worse at? Trade
      less (or smaller) there.
- [ ] **By grade** — are your A-setups actually your best results? If not, your grading
      criteria need work.
- [ ] **The bot's at-entry context (2026-07-26)** — auto-traded rows now carry the raw
      screener score, the market-regime label, market ATR%, an ET entry time, and (on
      live bracket exits) the exit reason. Export the journal to CSV and ask: do
      higher-score entries actually earn more? Does the system bleed in one regime and
      earn in another? Are stops doing all the closing while targets never hit? A month
      of trades is enough for a first read; none of these questions were answerable
      before these fields existed.
- [ ] **By discipline** — do checklist-followed trades beat the rushed ones? (They
      almost always do. Proof you can show yourself.)
- [ ] **Edge Report** — are top-ranked screener picks outperforming? Re-weight if not.
- [ ] **MAE/MFE** — any stop/target adjustments warranted?
- [ ] **Daily guardrails** — are your loss limit and trade cap set to numbers you'll
      actually respect?
- [ ] **Risk of ruin** — still comfortably low at your current risk %?
- [ ] **Alpha vs SPY** — beating buy-and-hold?
- [ ] **Market stress test** — could you stomach the −10% scenario? Trim gross exposure if not.
- [ ] **Back up your data** (Journal → export `.db`).

---

## Anti-patterns to avoid

- **Trading without a stop.** It breaks sizing and every analytic — and it's how
  accounts die.
- **Variable risk / "this one's a sure thing" sizing.** One oversized loser erases ten
  disciplined wins. Keep 1R constant.
- **Moving stops away from price.** Your MAE-on-losers will expose this; don't do it.
- **Chasing extended moves** with no defined entry/stop. If you can't state your stop,
  you don't have a trade.
- **Buying high-IV-rank long options** before an event and eating the IV crush.
- **Holding long options into expiry week** and donating the premium to theta.
- **Skipping the journal.** Unreviewed trades guarantee you repeat your mistakes.
- **Ignoring a negative alpha.** If you can't beat SPY, respect the data.

---

> ⚠️ **Disclaimer.** This playbook is educational and describes *process*, not
> recommendations. It is **not financial, investment, or trading advice**. No strategy
> here is guaranteed to be profitable; all trading carries substantial risk of loss,
> and you can lose more than you expect. Position-sizing math reduces risk, it does not
> remove it. Past results never guarantee future outcomes. You are solely responsible
> for your decisions. The app does not place trades.
