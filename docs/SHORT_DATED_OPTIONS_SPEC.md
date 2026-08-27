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

---

## Roll-out

1. ~~Build behind `shortDatedOptionsEnabled`, default off.~~ **Done.**
2. ~~Port the ladder to the paper book, so "paper first" is actually
   reachable — before this, paper still ran the 7-day DTE backstop and would
   have time-exited every 0-2 DTE contract on the tick after the fill.~~
   **Done 2026-08-27.**
3. **Paper first**, for at least two weeks. Every parameter above is a first
   estimate from a model, not from this book's own trades.
4. A **daily post-close read** runs every weekday at 16:30 ET, reporting which
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
