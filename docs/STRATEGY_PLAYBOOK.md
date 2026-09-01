# Strategy Playbook

How to use **Stock Trader** to trade more profitably.

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

> **Quitting while ahead is an exit rule too.** Auto-Trade's *Tune from target daily
> gain* stores your target % as a live daily goal (2026-08-21): once the account is up
> the set % on the day's starting value, the loop **banks the day** — no new live
> entries or scale-ins until the next session, while every exit keeps working. That's
> the same discipline as a stop, pointed the other way: a green day given back in the
> afternoon is a loss you chose. It never sizes up to chase a shortfall — if days
> chronically miss the target, lower the target or widen trade flow; don't raise risk.
> The **give-back guard** (2026-08-22) extends the same rule to the day that *almost*
> makes it: once the day has been up 2/3 of the goal, a fade back to 1/3 halts new
> live entries too — keep most of a good day instead of round-tripping it. Its
> companions attack the fade before it happens: **finish-line sizing** trims the
> closing trade to just what banks the day (never sizes up — pressing a shortfall is
> how accounts die), an **armed-day score bar** holds late entries to the highest
> conviction standard, and the **symbol loss cooldown** stops re-entering a name that
> just stopped you out twice — the "revenge trade" rule, automated. The **stagnation
> exit** completes the set from the capital side: a live position going nowhere after
> its deadline is scratched so the slot and risk budget go back to work — for a
> within-the-day goal, capital velocity is a lever, and dead positions are its tax.

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
A-grade setups actually out-earn your C-grade ones — and the Monitoring card's **method
performance** table answers the same question per instrument: whether long stock, short
stock, calls, or puts is currently carrying the daily goal (**method-weighted sizing**
leans size toward the answer, without ever switching a method off); **expectancy-weighted sizing** (Config →
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
- **Cheap within its own range is not the same as cheap versus reality.** IV rank only
  says where implied vol sits in its own recent history; the evidence-backed "buy
  premium when it's cheap" signal compares **implied to realized** volatility
  (Goyal–Saretto) — long premium pays the variance risk premium whenever implied runs
  above what the stock actually moves. The auto-trade loop's **options max IV/RV
  ratio** (Configuration, 2026-07-27, 0 = off) encodes exactly that: skip an options
  entry when the underlying's ATM implied vol exceeds your ratio × its 20-day realized
  vol, with **~1.0** meaning "implied no richer than realized". Expect it to cut trade
  count — its whole job is skipping entries where the premium itself is the losing
  bet — and like every gate here, **backtest it first**: the options/combined backtest
  API accepts the same `maxIvRvRatio` (via `optionsDecisionConfig`), and
  `npm run research -- --experiments ivrv` runs the pre-registered ratio ladder
  (off/1.5/1.2/1.0/0.8) through the options walk-forward for you, ranked by
  out-of-sample expectancy — so you can measure what the gate would have skipped
  before trusting it live.
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

**Sweep it, don't eyeball it.** `npm run research` (see the README's script list)
runs a pre-registered set of walk-forward experiments against a running instance —
exit geometry (the shipped 2R bracket vs. breakeven+trailing "runner" shapes),
min-signal-score at 0/40/60/75, long-only vs. both directions, two
relative-strength-tilted weight presets, and relative strength at the horizon the
evidence supports (off vs. RS added at 20/63/126-day lookbacks — the 20-day rung is
the reversal-zone control the earlier weights experiment unknowingly tested), plus
two **opt-in** options-engine sets
(`--experiments ivrv` / `--experiments optexits`): the IV/RV cheapness-gate ladder
at off/1.5/1.2/1.0/0.8, and options exit shapes (time-exit only vs. a 50% stop vs.
a 50%/100% stop+take-profit bracket vs. a breakeven+trailing runner, in
%-of-premium terms) — opt-in because their first run fetches option contract data
from Polygon (run them over a few liquid names) — and ranks every variant by
**out-of-sample** expectancy with the server's own bootstrap CI and p-value. The
discipline is baked in: one axis per experiment, OOS-only verdicts, and a closing
reminder that a sweep is many looks at one history — treat a winner as a hypothesis
to confirm on a fresh split (or forward, via snapshots and the Edge Report), never
as a conclusion. Costs aren't modeled, so favor liquid symbol sets and haircut
anything marginal.

**A worked example — the exit-geometry finding (2026-07).** The first two real runs of
that sweep (20 liquid large caps, Aug 2024 → Jul 2026, walk-forward split at
2025-12-01 and then a fresh-split confirmation at 2025-06-01) produced this playbook's
first recorded finding: **both breakeven+trailing "runner" shapes beat both
fixed-target brackets, on both splits, and every runner out-of-sample window was
positive.** Per-trade OOS expectancy across the two splits — runner trail 1R: +$212
then +$545; runner trail 1.5R: +$313 then +$410; bracket-3R: +$22 then +$42; the
shipped bracket-2R: −$94 then +$171. The stable signal is *trail beats fixed target*,
not any single number: the two runners swapped first place between splits and so did
the two brackets, so rankings _within_ each pair are noise, while the separation
_between_ the pairs held both times — and it agrees with independent evidence from the
live journal (zero 2R target hits across the bot's twelve decisive trades). Treat the
dollar figures as optimistic: costs aren't modeled, two splits over one history are
not independent confirmations, and the best p-value was 0.069.

**The postscript, and the lesson worth more than the finding (2026-08-26).** That
result sat in this playbook for six weeks while the live book could not act on it. The
runner shapes it recommends are built from breakeven and trailing stops — and those
three settings, though present in the config and showing as set in the UI, ran only in
the paper and backtest paths. A live position kept the stop it was born with for its
entire life. So the sweep's own recommendation was unreachable on real money, and the
corroborating evidence it cited (zero 2R target hits in twelve live trades) was in part
a description of that gap rather than of the market.

Before trusting a research finding, check that the live path can *express* it. A
setting that exists, validates, persists and displays can still reach nothing — the
config is a description of intent, not proof of behaviour. The cheap test is to grep
for where the value is read and confirm the execution path you care about is among the
readers. Three separate settings groups in this codebase failed exactly that test
(live partial exits, live options exits, live trailing), each found only by asking of a
specific number: *what code reads this?*

To trade the runner shape, set **Target R multiple** to 6, **Breakeven trigger
(R-multiple)** to 1, **Trailing start (R-multiple)** to 1, and **Trailing distance
(R-multiple)** to 1.5. The far target is deliberate — it stands in for "uncapped," and
the trail, not the target, is meant to end the trade; risk per trade is unchanged,
since the stop and sizing don't move. Two disciplines apply. First, keep equity
execution **paper-only** while this validates: the paper engine applies
breakeven/trailing on every tick, but a live equity entry places static bracket legs
with no trail management, so live would ride a 6R target behind a never-tightening
stop — not the shape that tested well. Second, the confirmation that neither backtest
split can give is forward performance: judge the runner era against the bracket era in
the Journal after a few weeks of paper trades.

**A second worked example — the options book (2026-07), where the sweep correctly
said no.** The other job of a pre-registered sweep is stopping a change, and the two
opt-in options-engine ladders (5 liquid mega-caps, Aug 2024 → Jul 2026, split
2025-12-01) did exactly that. The **entry** question first: the `ivrv` cheapness-gate
ladder came back negative at every rung — gate off: −$211/trade OOS; 1.5: −$212;
1.2: −$188; 1.0: −$176; 0.8: −$198 (all thin samples). Tightening to 1.0 trims the
bleed, so the gate is real harm reduction, but there is no positive expectancy
underneath it to protect. Then the **exit** question: the `optexits` ladder
(n=23 OOS, past the reliability floor) found the 50% premium stop genuinely binds —
time-exit-only baseline −$146/trade vs. −$110 with the stop, max drawdown down —
but the stop+take-profit bracket and the breakeven+trailing runner produced results
**byte-identical to the plain stop**, because across all 23 trades not one position
ever closed a day at +50% unrealized gain: the upside-management rules had nothing
to manage. That is the diagnosis, not a bug: at a 21.7% win rate with winners too
small to ever reach half-premium gains, the automated book's problem is not exit
engineering — it is that buying premium off momentum breakout signals pays the
variance risk premium (see Playbook C's cheap-vs-reality note) and produces almost
no winners at all.

Three evidence lines now agree — the VRP literature, both ladders out-of-sample, and
the live journal (the bot's options trades all bled out through time exits, while
every dollar of realized options profit came from MANUAL, event-driven puts). The
standing conclusion until something changes it: **don't arm automated options
entries; keep options discretionary**, and let the equity runner do the automated
work. If the paper options loop stays on for observation, set **Options stop-loss
(%)** to 50 (the one rule that provably binds) and **Options max IV/RV ratio** to
1.0 — harm reduction, not an edge. A change to this verdict should come the same way
the verdict did: a new pre-registered hypothesis (different entry signal, spreads
instead of long premium, an event-driven trigger) tested OOS first — not a re-tune
of the shapes these ladders already priced.

**A third worked example — relative strength at the right horizon (2026-07), one
adoption and one honest kill.** The original weights experiment's RS tilt lost — but
it ran at the shipped **20-day** lookback, squarely inside the documented one-month
*reversal* zone, so it never tested the cross-sectional momentum premium (which
lives at ~3-12 months). The `rshorizon` ladder registered the real claim: RS weight
15 added on top of the shipped mix, varying ONLY the lookback — off / 20d (the
reversal-zone control) / 63d / 126d — across the same two splits as the exits
finding. What survived both splits is **narrower than the hypothesis**: the joint
"longer is always better" claim FAILED (126d beat the baseline on one split and
lost to it on the other — parked), but **63d beat both the baseline and the 20d
control on both splits** (−$94 → +$14, then +$171 → +$280 per trade OOS, with the
win rate and max drawdown improving both times — p 0.086 on the confirmation
split), and the 20d control finished **last or near-last both times**. The control
is what makes this credible: horizon moves the result in the predicted direction on
both ends, so the mechanism — quarterly relative strength selects, monthly relative
strength mean-reverts — is doing the work, not a lucky rung. Adopted 2026-07-28:
**Relative strength weight 15, RS lookback 63 days**, benchmark SPY. Two caveats
stand: the ladder ran under the old 2R-bracket exits, so the RS-63 + runner-exits
COMBINATION is validated only forward, by the Journal; and the dollar figures are
pre-cost — the **Stop overrun** report above is the haircut to apply as real fills
accumulate.

The same confirmation pass killed a hypothesis, which is the discipline working:
**direction 'both'** beat long-only on the first split (+$49 vs −$94) and then lost
badly on the fresh one (+$43 vs +$171, with a deeper drawdown) — the shorts bled
into a friendly tape. A winner that doesn't survive the fresh split was noise:
**the loop stays long-only.** If shorting ever comes back, it comes back as a NEW
pre-registered, regime-conditional hypothesis (short only in risk-off tape), not as
a standing setting.

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

**Same-session trades are measured on intraday bars.** A trade opened and closed in one
session is read from 5-minute candles, narrowed to the minutes you actually held, so its
MAE/MFE reflects the trade rather than the day around it. Trades held overnight or longer
still use daily bars, which is the right granularity for them.

Intraday history is short, so when it isn't available for an older same-session trade the
panel falls back to daily bars **and says so** — it reports how many rows came from each.
A daily-bar row for a same-session trade is an upper bound, not a measurement: it credits
the trade with the day's full high and low, including hours you were flat. If the mix is
mostly daily, treat the averages as a ceiling.

**A sanity check worth doing first.** MAE and MFE should be in the same league as your
stop: a book stopped out at 1R cannot have an average MAE of several R, because those
trades would have been stopped long before. If the averages come back at implausible
multiples of your risk, something is measuring the wrong window rather than revealing a
hidden truth about your trading — and tuning stops or targets on it would move real money
against noise. This is not hypothetical: through 2026-08-25 this report measured every
trade against roughly six months of price history instead of its own holding period,
and reported a +20.95R average MFE and a −4.28R average MAE.

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

**The stop side of the same question — Stop overrun.** A limit-vs-fill report can't see
the most expensive slippage of all: a stop that executes **beyond** the price you
declared, because the stock gapped through it or the spread was wide when it triggered.
**Journal → Analytics → Stop overrun** measures exactly that, for every stock exit that
was a stop execution — including manual, imported, and paper-era trades, since the
comparison is against your own declared stop, not a broker order. Read it in **R**: an
average extra loss of +0.2R per stop means your real 1R is 1.2R, and any backtested
edge should be haircut by that much before you believe it (the backtest engines fill
stops exactly — see the backtest-reality notes above). The **entry price band**
breakdown is the micro-cap tax made visible: overruns concentrating under $15 are the
gap-throughs and wide spreads the loop's **min share price / min avg volume** floors
exist to keep you out of. If the beyond-% is high even in liquid names, the problem is
holding overnight through binary events — that's what the earnings blackout is for.

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

**"Why won't a second position open in the morning?" → Notional caps versus risk-based
sizing (2026-08-27).** Worth understanding, because the two are measured in different
units and the mismatch is easy to misread as caution. Risk-based sizing makes a position
*large in notional and small in risk*: at 1.25% risk over a 2.5% stop, one position is
**50% of equity in notional** but only **1.25% of equity at risk**. The correlated- and
sector-exposure caps compare **notional**, so a cap chosen as though it were a risk
number — 4% and 15% of equity, i.e. $206 and $774 on a $5.2k account — sits far below a
single $2,580 position. The arithmetic is structural, not an artefact of account size:
both sides scale with equity, so a *second correlated or same-sector position could never
open*, at any equity, no matter what the concurrent-position cap said.

That is a real cost if your edge is in the open. Volume and directional conviction are
greatest in the first hour, and morning momentum names are correlated almost by
definition — which is exactly the set those caps excluded. The book was configured for
two concurrent positions and could only ever reach one.

The fix is to size the notional caps against the notional they must admit. To let a
second position open while the first sits at the full per-order cap, the correlated and
sector caps must exceed that cap — **80% of equity** against a $3,871 order cap, with
margin rather than a knife-edge tie (75% lands 11 cents short, because the sizer's 1.5x
headroom makes the order cap *exactly* 75% of equity). Check the real risk separately,
and it is unchanged: two positions risk **1.25% each, 2.50% together**, against an
aggregate open-risk cap of 4.28% and a daily drawdown halt of 6.42%. **Both stopping out
on the same adverse move costs 2.50% — comfortably inside the halt that already exists.**

The account-exposure ceiling (`liveMaxExposurePct`) needed the same treatment for the same
reason, and it is the one number here that genuinely is leverage: it caps *gross deployed
capital* as a multiple of equity, measured against the broker's whole market value — so
positions you open by hand consume it too. Two positions at the full order cap come to
exactly 2 x 75% = 150% of equity, so a 150% ceiling tied and lost by 23 cents. It is now
**155%**, which clears the pair with ~$258 of margin and adds the least borrowing headroom
that does the job. A third position is still far outside it. Gross exposure is what hurts
when a stop cannot protect you — a gap or a halt — which is muted here only because the
book flattens five minutes before the close and holds nothing overnight; if that ever
changes, this is the first number to reconsider.

So loosening these did not add risk; it stopped a notional cap from silently overriding
the risk budget. What still bounds the book is what should: the concurrent-position cap,
the aggregate open-risk cap, and the per-trade risk %. A *third* correlated position
remains blocked on notional as well as on concurrency. If you ever raise concurrency
above two, revisit these caps deliberately rather than assuming they still bind.

**"Is the limit priced where trades actually go?" → Peak-R against the target (2026-08-27).**
Worth measuring rather than assuming, because the answer moves real money and the intuition
cuts both ways. Journal → Analytics → Excursions reports each closed trade's **MFE** — the
best unrealized profit it reached — in R. Read across the book, that says whether the
take-profit end of the bracket sits where trades actually travel, or above it.

The first read on this book: of 36 closed trades, **60.5% reached 1.0R but only 28.9%
reached 2.0R**, against a `targetRMultiple` of 2 — and `capturePct` was **−28.46%**, meaning
the average trade gave back more than it kept. Winners peaked at **1.83R** on average, which
under the built-in tuner's 0.8 capture fraction implies a **1.46R** target. Treat all of
that as an *upper bound*: 30 of the 36 were measured on daily bars, whose high spans hours
the position did not exist. The 8 intraday-measured trades had a median peak of **0.17R**.

The trap is concluding "so lower the target." Do the daily arithmetic first. At 1.25% risk
with a 4-trade daily cap, +3% means netting **2.4R**, and a *lower* target makes that
harder, not easier — at 2.0R a 2W/1L day clears it, at 1.0R you need 3W/0L, at 0.75R a
perfect 4W/0L. Smaller targets raise win rate and cap the winners that carry the day. An
MFE-based policy sim on the same 36 trades still favoured a nearer target (**+0.43R/trade
at 1.0R vs +0.20R at 2.0R**, against −0.16R as actually traded), but note what it also
says: **no target level reaches +3%/day on average within a 4-trade cap.** The lever that
would is win rate or trade count, not target distance.

So the rule here is: **let the tuner do it, from winners, gradually.** `autoTuneExitsEnabled`
moves `targetRMultiple` toward 0.8 × winners' average peak and `stopAtrMultiple` toward the
room the **90th percentile** of winners' heat needs (plus a 1.1 allowance), refuses to act
below `autoTuneMinTrades` winning trades, moves either by at most 0.25 per run, and clamps
hard.

The stop side used to read the **mean** heat × 1.3, and that was wrong in the expensive
direction. Heat is bounded above by 1R — a trade taking more than that was stopped out and
is not a winner — so real samples bunch mid-range with a tail pressed against the ceiling,
and the mean sits well below where the hardest-won winners live. On the first real sample
(9 winners: 0, 0.18, 0.29, 0.49, 0.50, 0.52, 0.53, 0.67, 1.00) mean × 1.3 granted 0.60R of
room and would have stopped out **2 of the 9**, including the one that took a full 1R before
winning. Tightening a stop to a level that kills a fifth of your winners is not a tuning, it
is a different and worse strategy. The percentile states the trade-off honestly — cover this
share of winners, give up the rest — and on that same sample grants 0.81R and gives up one. Winners only is the honest sample — a
trade that stopped out did so *because of* the current stop, so its excursion is censored
and cannot tell you whether a different geometry was better. Hand-setting a multiple off a
simulation, or off one memorable stagnant trade, is how you fit a parameter to noise.

**"Why did a whole session produce no trades?" → Sizing has to know what you can fund
(2026-08-28).** Position size came from risk alone — `riskPerTradePct` over the stop
distance — and buying power was checked only afterwards, at the guardrail, on a fully
sized order. So an unfundable order was built in full and then refused. On 2026-08-28 that
happened **627 times for zero entries**: buying power was $2,161.18 (a $5,000 deposit had
not settled) while the sizer kept producing $3,600–$5,378 orders.

The day was not unlucky, it was unwinnable by construction. Risking 1.25% of a $5,161
account inside $2,161 of buying power needs a stop **2.98%** away, and `maxStopDistancePct`
is 2.5 — so no order could be both correctly sized and fundable. A ~$2,000 position was
affordable the entire session and was never attempted.

**Buying power is not a fixed property of the account.** It moves with settlement holds,
with margin state, and with the previous days' wins and losses. That is precisely why it
cannot be a number anyone edits each morning — the sizer reads it and adapts.

Sizing down only ever *reduces* risk: fewer shares at the same stop is strictly less money
at stake than intended. What the loop must not do is pretend the risk target was met, so
every sized-down entry says so in its journal — `sized down to N of M shares to fit $X of
buying power — risking $A instead of the intended $B` — and an undersized book is visible
rather than being read as a normal one. Below **25%** of the intended size it skips
instead: a token position still costs a concurrency slot and one of the day's trades, and
returns almost nothing for them.

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

**Caps you set by hand stay yours.** The dollar guardrails — per-order
notional and the daily-loss limit — are normally derived from account equity,
and they re-derive themselves as the account grows or shrinks (a loss cap that
does not shrink with the account is a 22% halt wearing a 13% label). But a cap
you set deliberately is left alone: both the target tune and the automatic
re-anchor only move a cap that still matches its derived value. The trade-off
is the honest one — a hand-set cap no longer tracks equity, so if the account
changes size materially, revisit it yourself. Clear it back to the suggested
figure and the app resumes sizing it for you.

This matters most on a small account, where the derived per-order cap can land
*below* what correct position sizing produces. A 2% risk budget with a 3% stop
implies a position worth roughly two-thirds of the account; a backstop set at a
quarter of equity then blocks every legitimate entry rather than catching the
absurd ones it exists for. If entries are being refused on order notional, the
cap is the thing that is wrong, not the sizing.

**Bank something before the clock does it for you.** A position with a stop, a target
and a time limit has three ways out, and if the target is far enough away that a session
rarely reaches it, the *timer* becomes your real exit — closing trades at whatever they
happen to be worth when it fires, which averages out near break-even however good the
entries were. Taking part of the position off at a fixed R turns some of that into
realised profit while leaving the rest to run.

The mechanical warning, if you automate it: **shrink the resting stop to the remainder
before you sell the slice, never after.** Sell first and your stop still covers the
original size — when it fills, it sells shares you no longer own, and a long quietly
becomes a short. Doing it in the safe order means the worst case is a few shares briefly
unprotected, which is recoverable; the unsafe order creates a position nobody chose.

**Size your stop to your holding period, not to the daily range.** An ATR-based stop —
"1.5x the average daily range" — is calibrated for a trade you intend to hold for days.
Put the same stop on a position you will scratch in ninety minutes and it is not a stop at
all: it sits further away than the stock can plausibly travel while you own it, so it is
never hit, and every consequence follows from that.

Position size is the first casualty, because size is *risk budget divided by stop
distance*. A stop 14.6% away spends the entire budget on a single share. The second is the
target, which is usually a multiple of the stop distance: a 14.6% stop implies a ~29%
target, so neither bracket ever resolves and the trade exits on a timer instead — at
roughly break-even, every time. A daily goal is then arithmetically out of reach, not
because the setups were bad but because each one was sized to return a rounding error.

Measure what your trades actually do before choosing a number. On five real intraday
trades the adverse excursion was 0.21%-1.50% and the favorable 0.00%-1.55%, against
brackets an order of magnitude further out. On a genuine 14% mover the same day, the
stock went -1.15% / +3.42% after entry: a 2% stop survived, a 3% target was hit, and the
*same dollar risk* bought fourteen shares instead of one.

The counter-intuitive part is worth stating outright: **a tighter stop is not more risk.**
The dollars at risk are identical — you have simply put the stop where the trade is wrong
instead of where a week of trading might take it, and bought a position that can pay you
for being right. What you accept is a higher chance of being stopped, which is a real cost
and the reason to measure your own excursions rather than copy a number.

**Relative volume lies about the time of day.** The usual definition — today's volume
divided by the average daily volume — compares a partial day against a whole one, so it
climbs mechanically from near zero at the open toward 1.0 at the close no matter how a
stock is behaving. A fixed threshold on it is therefore wrong at every hour but one:
demanding "1.5× average volume" at 10am is really demanding seven or eight times normal
*pace*, and the same threshold at 3:30pm asks for almost nothing. Measured on a real
session, the median stock read **0.10** at 10:47am and exactly one name in 261 reached
1.0.

The fix is to compare against how far a normal stock has got by now, and the cheapest
honest estimate of that is the **median across everything you screened this minute** —
half the market is above it and half below, by definition. Dividing by it gives a pace
multiple that means the same thing all session, and that also cancels market-wide quiet
or busy days instead of letting them quietly move your bar. If you filter on relative
volume at all, filter on pace.

**Flat by the bell, if your edge is intraday.** An overnight hold is a different
trade from the one you entered: you keep the position but lose every tool that justified
it — no stop you can manage, no exit you can time, and a price discovered in an opening
auction you cannot participate in. If your entries are intraday, holding past the close
means taking gap risk your strategy never priced. The autotrade loop can close everything
in the last few minutes of the session (**End-of-day flatten**, in minutes before 16:00
ET; 0 is off). It flattens **winners too** — the decision is about the clock, not the
trade, because a winner gaps down exactly as easily as a loser.

Two details that make it work rather than merely fire. It runs before the bell, never
after: a close attempted into after-hours liquidity pays a wide spread to avoid a gap it
is already exposed to. And it **replaces a resting exit order** placed earlier in the day,
because a limit priced off a stale quote can sit unfilled while the market walks away from
it — which is how a position gets carried overnight by an exit that already decided to
leave.

**Apply the clock rules to every instrument, not just the convenient one.** A rule
that only covers part of the book is not a rule, it is a leak — and the leak grows in
whichever instrument the rule forgot. This loop's options positions had no intraday
time rule at all: the only automated timer was "close as expiration approaches", so a
contract bought at 14-60 days to expiry could sit for weeks. Worse, options draw from
the *same* concurrent-position budget as stock, so one forgotten contract could hold
half the slots for a month while the intraday strategy that owns the daily target went
short of room to trade. If you set a hold limit and a flatten because your edge is
intraday, they have to bind on calls and puts too, or the book quietly drifts back to
being a swing book with a day-trading label on it.

Two exceptions worth being deliberate about. A **stagnation** scratch does not
transfer: a stock that goes nowhere is holding a slot for free, while a long option that
goes nowhere is already paying for its slot through theta and has %-of-premium rules of
its own. And **re-pricing a resting exit** does not transfer either, because it does not
need to — an options close placed several percent through the mark is far likelier to
fill than an equity close placed a half-percent through it, so the stranded-limit problem
that motivates the replacement barely exists there. Port the rule; check each mechanism
against the instrument rather than assuming.

**Score the thing you are actually trading.** A screener assembled from
"momentum, trend, RSI, volatility" sounds like it measures movement, but check what each
component *reads*. If momentum averages today's change with the distance from two moving
averages, and a separate trend component scores that same price-vs-MA relationship again,
then the positional dimension — where a stock sits after weeks of trend — is being counted
twice while today's direction is a tenth of the total. That is a fine way to pick a
multi-week swing. It is the wrong question entirely for a position you will close before
the bell.

The failure looks reasonable from the outside, which is what makes it durable: a stock
down 3.45% on the day scored 71.8 for "momentum" because it still sat 9% over its 20-day
and 28% over its 50-day from an earlier run. It was bought long, journaled as a breakout,
and lost money. On that same day **a third of everything clearing the score threshold was
falling** — seventeen of fifty.

Two habits protect against it. First, **filter on direction, not just on score**: a long
needs the stock to be up today, whatever its position looks like. It is a blunt rule and
it removes an entire category of wrong trade. Second, when you weight a scoring system,
write down which components are about *now* and which are about *the past few weeks*, and
check the split matches your holding period. If you hold for minutes and your score is
60% positional, the score is answering someone else's question.

**Never let a safety limit block the exit.** A daily order cap is worth having — it is
the backstop against a bug that places the same order over and over. But a runaway loop
places *entries*, and refusing an *exit* does not reduce risk, it strands you in a
position you have already decided to leave. Every risk such a cap is nominally about is
better held by a limit aimed at it: entries by a trades-per-day cap, exposure by
concurrent-position and buying-power checks, a bad day by a drawdown halt. The order cap
is the only one that can trap you — so scope it to entries and let closes through
unconditionally.

The general rule this is an instance of: **risk-reducing actions should not be gated like
risk-adding ones.** Cancelling an order, closing a position, flattening at the bell —
none of these should ever be refused by a limit designed to stop you doing *more*. When
you find one that does, the symptom is unmistakable: the same close being retried and
refused, over and over, while the position moves against you.

**A cap that counts exits is not a cap on trades.** Autotrade carries two
separate daily limits and they are deliberately different numbers.
**Max trades per day** counts *entries* — it is your trade budget. The live
**orders per day** cap counts *every order sent to the broker*, and closing a
position is an order too. Setting them equal looks tidy and quietly breaks
things: a day that spends its budget entering has nothing left to exit with.
That is not a thought experiment — with both set to 4, a live day spent its
allowance on three entries plus one stagnation scratch, and the next scratch
the loop wanted was refused 44 times in a row on "4 placed vs 4/day". The
position was carried overnight by the guardrail that existed to protect it.
The app now derives the orders cap as **one entry plus one exit per trade**, so
raising your trade budget raises the room to close as well. If you ever set
these by hand, keep the orders cap at least double the trade cap. The general
lesson generalizes past this app: when you write a rule that throttles
*actions*, check whether "get me out" is one of the actions you just throttled.

**A target is a forecast about distance, and reward:risk cannot check it.** The
most expensive thing found in this app's exits, 2026-09-01. Targets were set as a
multiple of the stop, and the stop was capped at a flat percentage of price — so
the target asked for roughly the same 4.7% move whether the stock travels 2% in a
day or 18%. Measured across 22 live entries, **the median target sat at 1.06x the
name's ENTIRE daily range**, and 12 of 22 needed more than a full day's move, from
entries taken mid-morning and scratched 90 minutes later. One was given a limit
above its own 52-week high.

Reward:risk looked perfect the whole time. **2R says the target is twice the risk;
it says nothing about whether the stock can get there.** Those are different
questions and only one of them was being asked. The check that was missing is
embarrassingly simple: compare the distance to the target against the stock's own
average daily range. If you are asking for more than a day's move inside a day,
you do not have a target, you have a wish — and every trade that drifts sideways
into a time-based exit is that wish being quietly billed to you.

Two corollaries worth carrying to any system:

- **Anything derived from a capped input inherits the cap, not the intent.** The
  stop was meant to adapt to volatility (1.5x ATR) and then got clipped by a flat
  2.5%. Every target downstream was built on the clip, not the volatility, so a
  quiet name and a wild one got the same target distance. When you cap a value,
  find what reads it.
- **A level is a ceiling until it is the thing being broken.** Capping targets at
  a 52-week high sounds obviously right and would refuse every breakout — which is
  the setup a breakout screener exists to find. What separates the two is
  participation: volume. Rules about structure need a way to say "except when the
  structure is what is being taken out," or they quietly delete your best trades.

**The number a trade is booked at is not the number the signal named.** A third
version of the same disease, measured 2026-08-31. The bot's signals ask for 2R.
Its trades do not get 2R. When support sits inside the planned stop, the app
widens the stop to clear it — correct, a stop resting on a level buyers defend
is the worst place on the chart — but the target stays where it was, priced off
the *old* stop. Same reward, bigger risk, lower R. Across 285 adjusted plans that
session, **every single one came out under 2.0R**, median 1.53R, and 45% under
1.5R. The journal recorded the 1.53 and never recorded the 2.0 it started from,
so the cost was invisible for a week.

Two things generalize. First: **when you widen a stop, you have silently changed
every ratio derived from it** — reward:risk, position size, expectancy per trade.
Widening is usually right, and it is never free; if your target does not move
with your stop, decide that on purpose rather than by omission. Second, and more
useful: **record the ask, not just the outcome.** A row saying "1.5R" is
compatible with a healthy 1.5R strategy and with a 2R strategy losing a quarter
of its edge to mechanics, and you cannot tell which from the row. Any time your
system adjusts a plan, store what it wanted next to what it did — otherwise the
only thing you can audit is the adjustment's result, never its price.

**And a cap that counts nothing is not a cap at all.** The sibling failure to the
one above, found on 2026-08-31: **max trades per day** was enforced perfectly — it
was simply counting zero, every day, no matter how much the loop traded. It counts
positions whose *entry date* is today, and live positions were reaching the journal
with no entry date at all. Nothing errored, no tile turned red, and the Monitoring
panel cheerfully reported "0 placed" on a day with five entries against a budget of
four. The only thing actually holding the line was the orders-per-day cap, which
counts broker orders and cannot be fooled this way.

The lesson is not about this one field. **A limit is only as real as the number it
compares against, and that number is usually computed somewhere else by something
that does not know a limit depends on it.** So when you rely on a cap, do not check
that the cap is *set* — check that its *reading moves*. Trade twice and watch
"Trades today" go to 2. If a gauge you are trusting sits at zero on a busy day, it
is not reassuring you, it is broken; a limit that has never once refused anything
has not been proven safe, it has been left untested. That goes double for the caps
you most want to believe in, because those are the ones you stop looking at.

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
