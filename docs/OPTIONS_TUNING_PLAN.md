# Options tuning plan — how the daily read turns into changes

Companion to `docs/SHORT_DATED_OPTIONS_SPEC.md`. That document says what was
built and why. This one says **how it gets improved**, and — more importantly —
**when it does not**.

Written 2026-08-27, the day short-dated options went live on the paper book.
Every parameter in the ladder came from a Black-Scholes model at a single
volatility on a single hypothetical underlying. None has been checked against a
real trade. This plan exists so that changes to those numbers come from
evidence rather than from the most recent day's mood.

---

## The failure this is built to prevent

A daily check-in with no memory has exactly two failure modes, and they look
like opposites:

1. **It never changes anything.** Day 1: "sample too small." Day 2: "sample too
   small." Day 20: "sample too small." Each read is honest and each read is
   useless, because nothing accumulates.
2. **It changes something every day.** Each day's noise gets a parameter tweak,
   the tweaks interact, and after two weeks the system is worse than the model
   it started from — with no way to tell which change did it.

The defence against both is the same: **decide the rules before seeing the
data.** Everything below is pre-committed. When a threshold is met, the change
is made and logged. When it is not, the read says "no change" and moves on —
and that is a result, not a failure to produce one.

---

## Layer before parameter

The single most common tuning mistake is fixing the wrong layer. These must be
diagnosed **in order**, and a layer is only worth tuning once every layer above
it is healthy:

| Layer | Question | If broken, nothing below it means anything |
|---|---|---|
| **0. Funnel** | Does it place a trade at all? | Zero entries → exit stats are empty. Tuning the ladder here is tuning nothing. |
| **1. Signal** | Do entries get followed by movement? | If entries go nowhere, that is the *entry criteria*, not the exit. Loosening stagnation just holds losers longer. |
| **2. Ladder** | Do exits capture what movement there is? | Only meaningful once 0 and 1 are healthy. |
| **3. Edge** | Is any of this profitable? | The honest question. Answered at review, not daily. |

**Layer 0 is where this starts, and it is not a formality.** On 2026-08-26 live
options generated 14 signals and placed **zero** orders — every one died on
`risk budget is too small to size even one contract at this premium`. That is
the entire reason short-dated exists. Whether that reason has disappeared is
the first thing the daily read checks, every day, before anything else.

---

## Pre-committed decision rules

Each rule names its trigger, its minimum sample, and its response. **No
parameter moves without one of these firing.**

### Layer 0 — funnel

| # | Trigger | Min sample | Response |
|---|---|---|---|
| F1 | ≥3 consecutive sessions with 0 options entries, same dominant block reason | 3 sessions | Diagnose that reason per F2–F5. Do not touch the ladder. |
| F2 | Dominant reason is **risk budget** | 3 sessions | **No loosening.** Short-dated was the fix for this; if it still dominates, options are structurally unreachable at this account size. Report that and stop. Raising `riskPerTradePct` to reach an instrument is backwards. |
| F3 | Dominant reason is **liquidity** (`optionsMaxSpreadPct` 8, `optionsMinOpenInterest` 100, `optionsMinVolume` 10) | 3 sessions | **Measure before changing.** These were set for 7–21 DTE contracts; 0–2 DTE spreads behave differently. Sample the actual spread/OI/volume distribution on 0–2 DTE contracts across the universe, then set the gate from the observed distribution. Never widen a liquidity gate to hit a trade count. |
| F4 | Dominant reason is **DTE window** | 3 sessions | Likely structural: daily expiries exist for index ETFs and a handful of mega-caps, not for most of a 500-name universe. Report the share of the universe that *has* a 0–2 DTE chain. If it is small, the honest fix is a narrower universe for options, not a wider DTE band. |
| F5 | Dominant reason is **IV/RV** (`optionsMaxIvRvRatio` 1.0) | 5 sessions | 0DTE IV is structurally elevated into the close. If this blocks most candidates, report the observed IV/RV distribution before proposing a number. |
| F6 | `short_dated_entry_window_closed` on ≥50% of sessions | 5 sessions | The 210m cutoff is eating the day. Check *when* signals arrive: if they cluster after 12:30 ET, the problem is signal timing, not the cutoff. |
| F8 | Options entries refused on `max_concurrent_positions` while the options book itself has room | 1 session | The shared slot budget is starving the evidence track. Give options its own slots via `optionsMaxConcurrentPositions` — do **not** raise `maxConcurrentPositions`, which is shared with live equity and would let real money open another position to fix a paper-book problem. Found 2026-08-27: 184 options signals, zero orders, every one refused "2 open vs cap 2" while equity held both slots all session. |
| F7 | "max 1 at a time" refuses ≥5 candidates in a week | 1 week | Note it. Do **not** raise the cap — §D6 of the spec is explicit that two 0DTE positions can go to zero on one adverse move. Revisit only after ≥30 closed trades show the exits work. |

### Layer 1 — signal

| # | Trigger | Min sample | Response |
|---|---|---|---|
| S1 | `stagnation` ≥40% of exits | 10 closed trades | The entry signal is not producing movement. **Do not loosen stagnation.** Report which entry criteria the stagnant names shared. |
| S2 | Median underlying move at exit < 0.3% in either direction | 10 closed trades | Same conclusion as S1 by a different route: the names being picked do not move enough for this instrument. |

### Layer 2 — the ladder

**No ladder parameter moves before 15 closed short-dated trades.** Below that,
the read reports the distribution and says so.

| # | Trigger | Min sample | Response |
|---|---|---|---|
| L1 | `disaster_stop` fires **at all** | 1 | Immediate investigation, sample size irrelevant. It means something outran the underlying stop between ticks. Report the case in full — entry, tick timeline, underlying path. |
| L2 | `take_profit` never fires while `give_back` does | 10 closed trades | The 60% target is above what these contracts reach. Lower it to the **observed median peak gain**, not to a guess. |
| L3 | `hard_time` ≥50% of exits | 10 closed trades | Positions open too late or the thesis is too slow. **Tighten the entry cutoff, never loosen the 14:00 clock** — the clock is the one rule whose cost is arithmetic. |
| L4 | `underlying_stop` ≥50% of exits **and** median exit is a loss | 15 closed trades | 0.5% may be inside the noise band for the names being traded. Compare against each name's own ATR% before proposing a number. |
| L5 | `give_back` fires and the median outcome is worse than holding to the 60% target would have been | 15 closed trades | The trail is too tight. Raise `optionsGiveBackPct` toward 60–65 — one step, then re-measure. |
| L6 | Any single rule accounts for ≥70% of exits | 15 closed trades | The ladder has collapsed to one rule; the others are dead weight. Report which, and why the rest never get a turn. |

### The always-check

| # | Trigger | Response |
|---|---|---|
| A1 | Any options position open after the close | **Lead the report with it.** The ladder failed. Everything else in the report is secondary. |

---

## Change budget

- **At most one parameter change per week**, so an effect is attributable to a
  cause. Two changes in a week make both uninterpretable.
- **Never two changes on the same day**, regardless of how many rules fire. If
  two fire, take the one on the **lowest layer** — a funnel fix precedes a
  ladder fix, always.
- **Every change is logged below** with its trigger, evidence, and the metric it
  was expected to move.
- **Rollback rule:** if a change has not moved the metric it targeted within 5
  sessions, revert it. A change that does nothing is not neutral — it is noise
  in the next analysis.

---

## What the daily read actually queries

The journal writes roughly 1000 rows every 8 hours overnight and far more
during market hours, and the row endpoint caps at 1000 — so **an unfiltered
read cannot see yesterday.** Measured 2026-08-27: 1000 unfiltered rows spanned
7.9 hours.

Narrowing by action helps, but **only for low-volume actions.** Also measured
that day, at `limit=1000`:

| Query | Reach |
|---|---|
| unfiltered | 7.9h — cannot see yesterday |
| `actions=blocked` | 3.5h — still capped, worse in wall-clock |
| `actions=options_signal_generated,no_options_signal` | 5.4h — still capped |
| `actions=short_dated_options_exit` | uncapped (≤4/day, so years) |

So the two reads split:

**Layer 2 (the ladder) reads rows.** `short_dated_options_exit` fires at most
once per closed position, against a max of one concurrent position and a 4/day
order cap — a handful a day. The full history fits well under the cap, and the
rows carry the `rule`, `premiumGainPct` and `underlyingMovePct` the L-rules
need:

```
GET /api/autotrade/events?actions=short_dated_options_exit&since=<epoch_ms>&limit=1000
```

**Layer 0 (the funnel) reads counts, not rows.** `blocked` and the signal
actions fire hundreds of times an hour during market hours, so no amount of
paging reaches a two-week window. Use the summary endpoint, which counts by ET
calendar date and never materialises the JSON `detail` blob that makes a row
heavy:

```
GET /api/autotrade/events/summary?actions=<names>&since=<epoch_ms>
→ { summary: [{ date: 'YYYY-MM-DD', action, count }, ...] }
```

| Purpose | Endpoint | actions |
|---|---|---|
| Exit rule distribution (L1–L6) | `/events` | `short_dated_options_exit` |
| Entry funnel (F1–F5) | `/events/summary` | `options_signal_generated,no_options_signal` |
| Risk-check blocks (F2–F5) | `/events/summary` | `blocked` |
| Entry gates (F6–F7) | `/events/summary` | `short_dated_entry_window_closed` |

`since` should be the epoch ms of **2026-08-27**, when short-dated was
enabled, so every read covers the whole life of the feature rather than one
day.

One thing the summary cannot give you: the *reason* inside a `blocked` event's
`detail`. When F1 fires and the dominant reason has to be identified, pull the
rows for a single recent session (a narrow `since`) and read the detail there —
the summary establishes *that* blocks dominate, the rows establish *why*.

## Data-quality notes

Facts about the ACCOUNT that are not facts about the STRATEGY. Any analysis
reading `accountEquityUsd`, the daily-target gain %, or anything sized off
them has to know about these; the trade-level record does not, and the
distinction is the whole point of the section.

| Date | What happened | What it contaminates | What stays clean |
|---|---|---|---|
| 2026-08-27 | **+$5,000 deposited**, and **−$2.2k of manual (non-autotrade) trading**, on a day that also carried a hand-taken SPY 0DTE call | `accountEquityUsd` ($2,450 → $5,142 in one step), the daily-target gain % (read **+130.71%**, none of it trading), and every %-of-equity size derived from them. The equity series has a **discontinuity here — do not difference across it** | Autotrade's own P&L, which is computed from **tagged positions**, not from equity. Its real number for the day is **−$8.32** on one SMCI round trip. Manual fills are untagged and never enter it, so the trade-level record the 2026-09-05 review depends on is unaffected |
| 2026-08-27 (fixed) | The same deposit, as a **recurring** hazard | Nothing further — from this date the loop detects an external cash flow and moves the day's baseline by it instead of counting it as gain (`daily_baseline_rebased`), so a later deposit neither banks the day nor distorts the %-of-equity caps | The 2026-08-27 session itself is still contaminated as described above; the fix is not retroactive, so treat that date's equity-derived figures as unusable regardless |

The general rule this establishes: **equity-derived series are account facts and
carry deposits, withdrawals and manual trading; position-derived series are
strategy facts and do not.** When the two disagree, the position-derived one is
the one that says anything about whether this works.

---

## Decision log

Append-only. Every parameter change to the options path goes here, whether it
came from a rule above or from a direct instruction. A change not in this table
did not happen for the purposes of the next analysis.

| Date | Change | Trigger | Evidence | Expected effect | Outcome |
|---|---|---|---|---|---|
| 2026-08-27 | `shortDatedOptionsEnabled` false → **true**; DTE band 7–21 → **0–2**; `liveOptionsEnabled` true → **false** | Roll-out step 3 of the spec | 2026-08-26: 14 live options signals, 0 orders, all on risk budget vs $241–340 contracts against a ~$44 budget | Options become affordable; paper starts producing exit-rule data | — |
| 2026-08-27 | `optionsTakeProfitPct` 75 → **60** | Spec §D3 | Modelled: reachable on a ~+0.8% underlying move before noon; 75 was not | `take_profit` fires at all, rather than every winner ending on `give_back` or `hard_time` | — |
| 2026-08-27 | `optionsMaxConcurrentPositions` 0 → **1** | F8 | 184 options signals that session, **zero** orders — 930 blocks all reading "2 open vs cap 2" while paper equity (GREE, HRL) held both slots from the open | The paper options book can open a position at all, so the evidence track produces evidence | — |
| 2026-08-27 | The max-1 short-dated gate now journals `short_dated_position_already_open`; `liveOptionsMaxOrderUsd` **stays tied to the equity cap** (an option-BP bound was built, then withdrawn) | F7's own measurability, plus a follow-up to the row below | The gate returned silently, so **F7 had no event to count** — a gate throttling the book looked identical to one that never fired. Separately, option BP was **$471.41 at 16:30 and $322.36 an hour later**, against a day BP of $8,644.72 | F7 becomes measurable rather than nominal | **The option-BP bound was reverted before merge, deliberately.** These are STORED caps and `liveCapsReanchor` re-derives them from config alone, with no broker call, so it cannot see option BP. A cap bound to a figure only the tune observes — and which moved 32% in an hour — would read as hand-edited to the re-anchor and freeze out of re-anchoring: the exact trap the row below records. Bounding options **orders** by option BP belongs at use time, in `liveOptionsExecute`, where the live figure is in hand. Not done here: live options is off, so it gates nothing today |
| 2026-08-27 | `liveMaxOrderUsd` 3000 → **3871**, `liveMaxDailyLossUsd` 344 → **331**, `liveOptionsMaxDailyLossUsd` 344 → **331**, `liveCapsAnchorEquityUsd` 5352.23 → **5161.18** | Operator instruction: the per-order cap "should be auto established depending on the BP available" | The cap and the sizer disagreed by construction: the sizer asks for `riskPerTradePct / maxStopDistancePct` = 1.25/2.5 = **50% of equity ($2,580)**, the cap allowed the moderate band's **25% ($1,290)**. Every order was larger than the cap that had to approve it | Caps are re-derived from the merged formula — `max(band, sizerFloor x 1.5)` bounded by buying power (day BP $8,644.72, non-binding here) — so the cap clears the sizer floor at **1.50x** and entries stop failing on their own configuration | **Moving the anchor to current equity is the point.** Written alone, these would read as hand-edits and be frozen out of re-anchoring forever; with the anchor moved they are anchor-owned, so every future re-anchor maintains them from equity automatically. `liveOptionsMaxOrderUsd` deliberately **left at 1338** — live options is off, options orders are premium-sized (~$30–50), and option BP is only **$471.41**, so the derived $3,871 would be a backstop that cannot backstop. It stays hand-edited. Binding the stored twin to option BP was tried and reverted the same day (see the row above) — the right place for that bound is use time, not a stored cap |
| 2026-09-05 | The buying-power bound on the **equity** per-order cap is removed — `deriveDollarCaps` is now a pure function of equity and the config percentages. Funding still reaches `/tune/preview`, but only to raise a **warning** | Audit follow-up: the options-side bound was reverted on 2026-08-27 for a reason that applied just as much to the equity side, and nobody carried it across | `deriveDollarCaps` has three call sites and only ONE — the tune apply — has a broker call. `handEditedDollarCaps` and `liveCapsReanchor` work from config alone, by design. So on any day funding actually bound the cap, the tune STORED the smaller figure while the anchor check re-derived the larger one; the two disagreed, and the cap was flagged hand-edited and skipped by **every future re-anchor** | The stored caps describe intent and stay anchor-owned; funding is enforced at decision time by `fundableMaxQuantity`, where the live figure is actually in hand | **Never triggered in production** — day BP ($8,644.72) sat above the derived cap ($3,871) every time the bound was live, so it never bound and never froze anything. The old unit tests passed under the defect throughout: they asserted the arithmetic of `deriveDollarCaps` where it is COMPUTED, and the failure was a disagreement BETWEEN two callers. The regression test now drives a tune under starved BP and asserts `handEditedDollarCaps` returns empty and the next re-anchor still moves the caps |
| 2026-08-27 | Universe: **+SPY, +QQQ** (526 → 528) | Operator instruction, after a manual SPY 0DTE call carried the whole day's +11% | The loop screened 34 distinct names that session — OKTA, HRL, DG, CRWD — and **no index ETF once**. The instrument the short-dated ladder was built for is one the universe could not see | SPY/QQQ reach the options decision, where 0–2 DTE chains actually exist and are liquid | **Watch, do not tune.** There is no separate options universe: options candidates are the equity-screened set, so both must first clear a single-name volatility-breakout screen. Three plausible blocks — `minChangePct: 1` (an index rarely moves 1%), `skipped_unknown_sector` (ETFs have no GICS sector; fired 69× that day), and `optionsMaxIvRvRatio: 1` (index IV usually sits above realized). No gate was loosened to make room; the next read reports where they actually die |

---

## What this plan will not do

It will not fit the screen to one memorable trade. The 2026-08-27 SPY entry
above is the live test of that: a hand-taken index trade made the day's entire
return while the loop, blocked four separate ways, produced one losing position.
The tempting read is "automate what worked". The disciplined one is to put SPY
and QQQ where the loop can see them, change nothing else, and let a few sessions
say whether an index-level signal survives a screen built for single-name
breakouts — knowing the honest answer may be that it does not, and that the gate
which excludes it is right to.

It will not produce a tuning change from a single day, and it will not treat
"no change recommended" as a wasted read. Most days early on should end that
way. The parameters here came from a model; the point of the next few weeks is
to accumulate enough real trades to say something about them that the model
could not — and the fastest way to destroy that is to start fitting to noise on
day two.

The 2026-09-05 review is where the accumulated picture gets judged against the
question the spec could not answer: whether there is any edge here at all.
