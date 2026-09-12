# Short-dated options (0–2 DTE) — design spec

Status: **built 2026-08-26** (live path), **ported to paper 2026-08-27**.
Shipped OFF behind `shortDatedOptionsEnabled` on both books. Spec written the
same day as the build; the modelled tables below are what every parameter came
from, and none has yet been checked against a real trade.

---

## Why this exists

Live options were switched on 2026-08-26 and placed **zero orders**. Fourteen
signals were generated; every one died on the same risk check:

> `quantity: risk budget is too small to size even one contract at this premium`

Contracts in the configured 7–21 DTE band cost **$241–340**. The per-trade risk
budget on a $2,229 account at 1.97% is **~$44**. One contract is 5–8× the entire
budget for a trade, so no DTE or IV loosening can help — the instrument is
simply too expensive for the account.

Short-dated contracts are the only ones that fit:

| | T left | premium | contract | fits $44? | +1% move | +2% move | theta over hold |
|---|---:|---:|---:|:---:|---:|---:|---:|
| **0DTE** | 0.9s | 0.39 | **$39** | **YES** | +26% | +180% | **−58%** |
| 1DTE | 1.9s | 0.57 | $57 | no | +33% | +117% | −26% |
| 2DTE | 2.9s | 0.70 | $70 | no | +30% | +94% | −17% |
| weekly ~5d | 5.0s | 0.91 | $91 | no | +26% | +70% | −10% |
| current 7d | 7.0s | 1.08 | $108 | no | +23% | +59% | −7% |

*(Black-Scholes, $100 underlying, 35% IV, delta 0.30, entered with half a
session left. "Contract" is premium × 100.)*

This is also a natural fit on paper: the loop is already flat by every bell, so
an instrument that must not be held overnight costs it nothing.

**But 0DTE breaks every exit rule the options path currently has**, and the rest
of this spec is about that.

---

## The three numbers that drive the design

All from a 0DTE delta-0.30 call bought 09:45 at $0.41, modelled through the day.

### 1. Decay is not linear — it cliffs after ~14:00

Premium vs. the 09:45 entry, by time and underlying move:

| time | hrs left | flat | +0.5% | +1% | −0.5% |
|---|---:|---:|---:|---:|---:|
| 09:45 | 6.25 | 0% | +42% | +95% | −32% |
| 10:30 | 5.50 | −11% | +29% | +81% | −42% |
| 11:30 | 4.50 | −28% | +11% | +62% | −55% |
| 12:30 | 3.50 | −45% | −9% | +40% | −69% |
| 13:30 | 2.50 | −63% | −32% | **+15%** | −82% |
| 14:30 | 1.50 | −82% | −58% | **−15%** | −94% |
| 15:00 | 1.00 | −91% | −73% | −34% | −98% |
| 15:30 | 0.50 | −98% | −90% | −59% | −100% |

**Read the +1% column.** A trade whose thesis was *completely correct* — the
underlying moved a full percent the right way — is **+15% at 13:30 and −15% at
14:30**. Past roughly 14:00, being right stops paying. By 15:00 it is −34%.

The equity flatten at 5 minutes before the close is therefore catastrophically
late for 0DTE. It would convert correct trades into near-total losses.

### 2. A winner that reverses goes negative fast

Underlying runs +1% by 11:30 (premium **+62%**), then retraces:

| retrace | premium |
|---|---:|
| peak | **+62%** |
| gives back ¼ of the move | +14% |
| gives back ½ | **−9%** |
| gives back ¾ | −29% |
| gives back all of it | −45% |

Half a retrace turns a +62% winner into a loser. There is no "let it breathe"
on a 0DTE — unrealised gain is perishable in a way stock gain is not.

### 3. A percentage stop on the premium measures theta, not the thesis

Premium change at 10:30 (45 min in) for a given underlying move:

| underlying | premium |
|---|---:|
| +0.00% | **−11%** |
| −0.25% | −28% |
| −0.50% | −42% |
| −0.75% | −54% |
| −1.00% | −63% |

The underlying doing **nothing** already costs 11% at 10:30 — and 63% by 13:30.
The current `optionsStopLossPct: 40` therefore fires on a flat tape by early
afternoon, every time, with no adverse move whatsoever.

**A %-of-premium stop is not a stop on a 0DTE. It is a clock.**

---

## The design

### D1. DTE band and the coupled constant

- `optionsMinDte: 0`, `optionsMaxDte: 2`.
- **`AUTOTRADE_TIME_EXIT_DAYS` must move from 7 to 0 in the same change.**
  `evaluateExit` fires `time-exit` on `dte <= 7`. Left at 7, the loop would buy a
  0DTE contract and sell it on the very next tick, paying the round-trip spread
  for nothing, every time. This is the single easiest way to burn money here and
  it must not be split across two PRs. Both books now gate it through their own
  `timeExitDaysFor(cfg)`, and both carry a test pairing "flag on, 0DTE held"
  with "flag off, closed on the DTE rule" so the coupling cannot silently come
  apart later.

### D2. The stop is on the UNDERLYING, not the premium

New: `optionsUnderlyingStopPct` (default 0.5).

Exit when the **underlying** has moved that far against the position, measured
from the underlying price at entry. Time-invariant: it means the same thing at
10:00 and 13:00, which a premium percentage never can.

The existing `optionsStopLossPct` does **not** stay in play alongside this.
When the flag is on, both `optionsStopLossPct` and `optionsTakeProfitPct` go
quiet on the `evaluateExit` path and the ladder owns the premium entirely —
a separate `optionsDisasterStopPct` (~70) is its backstop.

This is not tidiness. The first build left `optionsStopLossPct` live next to
the ladder, and production runs it at **40**. Per the table in §3, a 40% stop on
the premium is reached on a **flat tape** by early afternoon, so it would have
pre-empted the underlying stop on every position, every day, with no adverse
move whatsoever — the exact failure this section exists to prevent, silently
reintroduced one rule below it. Caught 2026-08-27 during the paper port and
fixed on both books; both now carry a regression test that pairs "flag on, does
not fire" with "flag off, does fire", so a future revert cannot pass quietly.

Requires storing the underlying price at entry on the options position. The
live table gained `underlying_at_entry` on 2026-08-26; the paper table gained
the same column on 2026-08-27. Paper needs no `peak_premium` twin — its
`best_basis_since_entry` column already tracks the running peak of exactly the
same net basis for its trailing stop, so the give-back trail reads that.

### D3. Take profit twice: a fixed target AND a give-back trail

Because unrealised gain is perishable (§2), one fixed target is not enough.

- `optionsTakeProfitPct` **60** (down from 75). Reachable on a ~+0.8% move
  before noon, per the table.
- New `optionsGiveBackPct` (default 50): once the position has been up at least
  `optionsGiveBackArmPct` (default 40), exit if it retraces more than half of
  its **peak gain**. At the worked example — peak +62%, exit around +31% —
  rather than riding it to −9%.

The give-back trail is the answer to "they move fast in both directions". It
needs a peak-premium high-water mark on the position, the options analogue of
`bestPriceSinceEntry`.

### D4. Two clocks, both much earlier than equity's

- `optionsHardExitMinutesBeforeClose` (default **120**, i.e. 14:00 ET). Hard
  flatten. Past this the +1% column is negative — being right no longer pays.
- `optionsNoEntryMinutesBeforeClose` (default **210**, i.e. 12:30 ET). No new
  short-dated entries after this: a contract opened at 13:30 has one usable hour
  and a 63% decay headwind.

Both are separate from the equity `endOfDayFlattenMinutes: 5`, which stays.

### D5. Stagnation — a deliberate reversal of the earlier rule

`stagnationExit.ts` excludes options because "a stagnant long option is already
paying for its slot through theta." At 30 DTE that is a mild cost. At 0DTE it is
**−11% by 10:30 and −28% by 11:30**, which is the dominant risk.

Short-dated positions get a stagnation cut: if the underlying has not moved
`optionsStagnationMinMovePct` (default 0.3) in the position's favour within
`optionsStagnationMinutes` (default 30), close it while the premium still has
value. Longer-dated options keep the existing exclusion.

### D6. Loss gates

Mostly already present; listed so the whole surface is visible in one place.

| gate | value | status |
|---|---|---|
| Defined risk — premium is max loss | ~$44 = 1R | exists (sizing) |
| `liveOptionsMaxDailyLossUsd` | 141 (~3 full losses) | exists |
| `liveOptionsMaxOrdersPerDay` | 4 | exists |
| Shared concurrent-position cap | 2, with equity | exists |
| **Max 1 concurrent short-dated position** | new | **to build** |
| `liveOptionsProbationTrades` | 0 → set to 10 at 0.5× | **to change** |

The concurrency cap matters more here than for stock: two 0DTE positions can
both go to zero in the same 30 minutes on one adverse market move, which is a
correlation stock positions do not have.

---

## Order of exit checks

Highest priority first. First match wins.

1. **Hard time exit** (§D4) — nothing survives 14:00.
2. **Underlying stop** (§D2) — thesis is wrong, cut it.
3. **Give-back trail** (§D3) — was up, is fading.
4. **Take profit** (§D3) — target reached.
5. **Stagnation** (§D5) — going nowhere, bleeding.
6. **Premium disaster backstop** (§D2) — ~70%, gap protection only.

The clock outranks everything because it is the only rule whose cost is
certain. Every other rule is a judgement about price; the 14:00 cut is
arithmetic.

### A working close is chased to the bid (2026-09-12)

A position whose closing order is already resting at the broker used to be
skipped by this whole ladder — otherwise every tick would submit another close
for the same position. Two separate failures came out of that skip, a day apart,
and the fix arrived in two steps.

**Step one (2026-09-10): the clock outranks a working close.** NKE: the
underlying stop fired at 10:27 and placed a $0.20 sell. The mark fell to $0.12
and the order sat unfilled for 4h20m, closing only because the underlying
happened to reverse into it. Had NKE kept rising, a 1 DTE contract would have
expired worthless behind its own protective order, because the skip hid it from
the hard time exit meant to catch exactly that.

**Step two (2026-09-12): the clock is not enough.** HOOD 260911C116, one
contract bought at 0.90 at 10:16 ET. `take_profit` fired at +64% and placed a
1.40 sell against a 1.47 mark; it never filled. Every tick after that saw a
working close and skipped the position. No rule fired again until `give_back`
at 11:15, by which time the trade was **-43%**. For 57 minutes the loop looked
at that position every 60 seconds and did nothing.

That gap is structural. **Between the take-profit level and the give-back arm
level, no ladder rule fires** — and that band is exactly where a working close
lives, because a close is placed when a rule fires and then rests while the
contract drifts back through the quiet middle. Gating the re-examination on a
rule firing means the one state that needs watching is the one state nothing
watches.

So a working close is now re-examined **every tick**, and the question is asked
against the **bid** rather than the midpoint:

- **At or below what the contract can be sold for** → left alone. A buyer is
  within reach, and NKE's own $0.20 close proves the point: it came back and
  filled for +$6, where cancelling and re-selling would have booked -$14. Never
  re-price a fillable order downward. This half is unchanged.
- **Above it** → cancelled, and a fresh close placed where the contract can
  actually be sold, carrying the **original decision's exit reason**, read off
  the order row. The ladder is not re-run for a position already in exit: the
  rule that placed the close has fired, and re-deriving it would let a later
  rule silently overwrite an earlier decision.
- **No usable quote, or no resting limit price** → left alone. Protection is
  never cancelled on a guess.

A clock rule no longer gates any of this; it only labels the trigger
(`clock` vs `chase`) in the journal.

**Why the bid.** The option chain this path prices from is Yahoo-sourced and
**~15 minutes delayed**, and it was collapsed to a midpoint before a 5% buffer
was applied — an average of a price nobody is offering and one nobody is
bidding, as of a quarter of an hour ago. Webull's own `/option/snapshot`
returns real-time OPRA bid/ask and nothing on this path read it. The close is
now priced at the OPRA bid when that snapshot is present and under two minutes
old, then the chain's bid, then the buffered mark. The exit ladder above still
evaluates on the **mark** — its rule levels are defined there and do not move.

The intent's reference price follows the basis. The fat-finger guardrail judges
|limit − reference|, so a real-time bid against a stale-high midpoint reads as a
40% deviation and would block the exit exactly when it is most needed. A bid
further under the mark than the account's own `liveOptionsFatFingerPct` is
treated as corrupt, journaled, and ignored in favour of the mark.

**A sub-tick mark no longer refuses the close.** `roundOptionPrice` rounds a
sell DOWN, so anything under half a tick became zero and was refused: HOOD's
14:00 hard-exit replacement computed `roundOptionPrice(0.03 × 0.95) = 0` and
journaled "No usable exit quote (mark 0.03) — below the $0.05 option tick" every
tick until 17:05. A contract worth three cents often still has a nickel bid, and
an order at one tick either fills or is refused by the broker once; both beat
never trying. A price that rounds off the bottom of the grid is floored at one
tick. A mark of exactly 0, no quote at all, or a crossed spread is a broken
quote rather than a contract worth a tick — those still refuse, and the expiry
sweep owns the position.

**Four guards on the chase**, each with its own test:

| guard | rule |
| --- | --- |
| fill race | after an accepted cancel the broker's order status is read directly (`cancelIntent` cannot report it — its reconcile defers on autotrade options intents by design). Filled → place nothing. Partially filled → re-place only the remainder. |
| mid-fill | a partially-filled order touched within two ticks is being worked right now; cancelling turns one clean close into two partials |
| budget | 20 re-prices per position per ET day, counting cancels. Past it the order rests and the expiry sweep owns the position |
| kill switch | a cancel with no replacement leaves the position with no working order at all — worse than a stale one. Both are held |

A refused cancel places nothing and retries next tick: two working sells on one
long option is how a covered close becomes a naked short.

Journal actions: `live_options_stale_exit_cancelled`,
`live_options_stale_exit_cancel_failed`, `live_options_exit_left_working`,
`live_options_stale_exit_unjudgeable`, `live_options_exit_reprice_deferred`,
`live_options_stale_exit_kept`.
`live_options_exit_placed` now carries `priceBasis`, `bid`, `mark`,
`quoteSource`, `quoteAgeMs`, `clampedToTick`, and — on a replacement —
`replacedIntentId`, `trigger` and `repriceCount`.

**An expired 0DTE is settled the same evening (2026-09-12).** The expiry sweep
took positions expiring strictly *before* today, because a contract is tradeable
all through its expiration day. True during the session, false after it: HOOD's
row sat open all evening holding a concurrency slot and aggregate-risk headroom
that both books draw on. The window is now "before today, **or** today once its
own session has closed". A contract settling on its own day gets no walk-back to
a prior day's close (that is a different day's price, and could book $0 on a
contract that finished in the money), and one whose daily bar has not landed yet
waits quietly instead of raising a review flag — an in-the-money same-day expiry
still flags at once, because the account may be holding assigned stock tonight.

#### Price the replacement BEFORE cancelling (2026-09-11)

The 2026-09-10 rule cancelled first and placed second, and it guarded only the
case where the **cancel** fails. It never guarded the case where the cancel
**succeeds** and the placement then fails — which is what HOOD did the very next
session. Its stale $0.20 sell was cancelled at 14:00, the replacement could not be
priced because the mark had fallen to $0.03 (below the $0.05 tick once the sell
buffer applies), and the position spent the rest of the day with no resting order
at all. That is the exact invariant the rule's own note claimed to hold.

Nothing was lost on that instance: the cancelled order rested above a market
decaying to zero and could never have filled, and the contract expired the same
day. On a contract that is not worthless, cancel-then-failed-place strips real
protection.

So the order is **price, then cancel, then place** — and it stays that way under
the every-tick chase above, which only makes the question more frequent. The probe
runs through the same quote resolution and the same limit helpers
(`sellableExitLimit` / `sellableSpreadExitLimit`) as the placement, so the two
cannot disagree about whether a contract can be sold at all, and a quote failure
answers "no" for the same reason: losing the quote is not the moment to pull the
only working order. A close that cannot be re-priced is left in place and
journaled once per position per day as `live_options_stale_exit_kept` — an
unfillable order still beats no order.

The tick clamp (2026-09-12) narrows when that happens without weakening it: a
tiny-but-real mark now prices at one tick rather than failing the probe, so
"cannot be priced" means a contract with no quote at all, a mark of exactly zero,
or a crossed spread. Those are the cases where keeping the stale order is the
whole of the protection.

Every exit failure is throttled to once per position per **cause** per ET day,
with a push on the first claim. An unplaceable mark is not a transient — a
near-worthless contract stays unplaceable until it expires and the sweep
re-evaluates every tick, so HOOD wrote 94 identical rows in one afternoon.
Retrying is still right; saying it 94 times is not, and the streak alert counts
rows, which is why the first one pushes.

**A reading note that outlives the bug.** Those repeats also inflated the ladder's
own history: 117 raw `short_dated_options_exit` rows since 2026-08-27 were only
**22 distinct closed trades**, and 95 of them were one position re-journaling. Read
raw, `hard_time` looked like 53% of exits and rule L3 would have fired on an
artefact; deduplicated on position, `hard_time` has never once been the rule that
closed a trade. **Always dedupe on book + positionId before applying an L-rule.**

---

## Roll-out

1. ~~Build behind `shortDatedOptionsEnabled`, default off.~~ **Done.**
2. ~~Port the ladder to the paper book, so "paper first" is actually
   reachable — before this, paper still ran the 7-day DTE backstop and would
   have time-exited every 0-2 DTE contract on the tick after the fill.~~
   **Done 2026-08-27.**
3. **Paper first**, for at least two weeks. Every parameter above is a first
   estimate from a model, not from this book's own trades.
4. A **daily post-close read** runs every weekday at 16:30 ET, working to
   `docs/OPTIONS_TUNING_PLAN.md` — which holds the pre-committed decision
   rules, the one-change-per-week budget and the decision log, so the
   accumulating reads turn into changes without turning into noise. It reports which
   of the six rules fired and how the entry funnel broke down. The rule
   distribution is the most informative number: `hard_time` dominating means
   entries are too late or the thesis too slow; `stagnation` dominating means
   the problem is the signal rather than the exit; `disaster_stop` firing at
   all means something outran the underlying stop. It is explicitly instructed
   not to manufacture a tuning change from a single day.
5. Judge the accumulated picture at the 2026-09-05 review.
6. Only then consider live, and with probation at 0.5× for 10 trades.

---

## Honest assessment

This makes options **reachable** on a $2.2k account. It does not make them
**good**.

0DTE is the highest-variance instrument this system could trade: a high loss
rate punctuated by occasional large winners. That sits awkwardly with a
daily-target objective, which rewards consistency over magnitude. The gates
above are designed to bound the damage, not to make the strategy work — whether
there is edge at all is an empirical question this spec cannot answer.

The parameters here come from a Black-Scholes model at a single volatility on a
single hypothetical underlying. Real 0DTE contracts have wider spreads, more
volatile implied vol, and pin behaviour near the strike that this model does not
capture. Treat every number as a starting point to be measured, not a setting to
be trusted.
