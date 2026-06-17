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
7. [Tuning stops & targets with MAE/MFE](#tuning-stops--targets-with-maemfe)
8. [Guardrails: risk of ruin & the benchmark](#guardrails-risk-of-ruin--the-benchmark)
9. [The weekly review checklist](#the-weekly-review-checklist)
10. [Anti-patterns to avoid](#anti-patterns-to-avoid)

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

### 5. Review on a cadence

Edge decays and habits drift. The **Edge Report**, **by-tag/by-grade/by-discipline**
breakdowns, **drawdown**, and **alpha vs SPY** exist so you can prune what doesn't work
and double down on what does. A trade you don't journal is a lesson you paid for and
threw away.

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

**Sizing from your own edge.** Once you have ~20+ decisive closed trades, the Journal's
**Kelly suggestion** proposes a risk % from your realized win rate and payoff ratio.
The app deliberately returns a **quarter-Kelly, capped at 3%** — full Kelly is wildly
volatile and assumes your edge is exact. Treat it as a ceiling, not a target.

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
- Mind **IV rank.** Buying long premium when **IV rank is high** means you're paying up
  and exposed to an IV crush (e.g. after earnings). Prefer **low-to-moderate IV rank**
  for long options, or accept the risk knowingly.
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

---

## Tuning stops & targets with MAE/MFE

Open **Journal → Excursions** (closed stock trades). For each trade it shows:

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

---

## Guardrails: risk of ruin & the benchmark

Two questions every serious trader must keep answering:

**"Can this kill my account?" → Risk of ruin (Journal).**
Set your per-trade risk and a "ruin" drawdown threshold (say 30–50%); the Monte Carlo
sim runs thousands of trade sequences drawn from your edge and reports the **% that hit
ruin.** If that number is anything but tiny, **cut your risk % until it is.** Survival
first — you can't compound an edge from zero.

**"Is my trading even worth it? → You vs SPY (Journal).**
Your **alpha** is your realized return minus simply holding the index over the same
window. If alpha is persistently **negative**, the honest move is to trade smaller and
buy the index — and the app will have just saved you a lot of money. If it's
**positive and stable**, you've earned the right to keep going (and maybe scale).

---

## The weekly review checklist

Spend 20 minutes every weekend in the **Journal**:

- [ ] **Equity curve & drawdown** — trending up? Currently in a drawdown? How deep vs
      your max?
- [ ] **Expectancy & profit factor** — still positive? Trending which way?
- [ ] **SQN (System Quality Number)** — is your edge strong *and* consistent? Below ~2
      means the system is hard to trade at size; aim to push it up by tightening
      losers (lower R std-dev) more than by chasing bigger winners.
- [ ] **By tag** — which setups earn? Drop or shrink the losers.
- [ ] **By grade** — are your A-setups actually your best results? If not, your grading
      criteria need work.
- [ ] **By discipline** — do checklist-followed trades beat the rushed ones? (They
      almost always do. Proof you can show yourself.)
- [ ] **Edge Report** — are top-ranked screener picks outperforming? Re-weight if not.
- [ ] **MAE/MFE** — any stop/target adjustments warranted?
- [ ] **Risk of ruin** — still comfortably low at your current risk %?
- [ ] **Alpha vs SPY** — beating buy-and-hold?
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
