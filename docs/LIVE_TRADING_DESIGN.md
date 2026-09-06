# Live Trading — Design Proposal (guardrails-first)

> **STATUS: PROPOSAL — not implemented.** As of today the app **never places trades**
> (see `CLAUDE.md`, top line). This document is a design for review. Nothing here ships
> until it's approved, and even then only in the phased, opt-in, guardrailed form below.
> This is **not financial advice**; live trading carries substantial risk of loss and is
> entirely the operator's responsibility.

---

## 1. Goal & guiding stance

Today the app is **decision-support**: it scores setups, scans option entries, evaluates
exit rules, tracks a journal, and syncs positions from Webull — all read-only. The goal of
this effort is to let the operator **optionally place a single, fully-reviewed order**
through Webull from inside the app, **without** turning it into a signal-fired auto-trader.

The stance, in one line: **the human is always the trigger.** The app prepares an order,
shows exactly what will happen, enforces hard limits, and submits **only** on an explicit,
per-order confirmation. No alert, score, or rule ever submits an order on its own.

## 2. Non-negotiable principles

1. **Off by default.** Trading is dark unless `TRADING_ENABLED=true` **and** a per-session
   arming step is taken. Fresh installs, demo mode, and CI can never trade.
2. **Human-in-the-loop, every order.** Confirm-and-place only. There is no path from an
   alert/score/rule directly to a submitted order.
3. **Dry-run first.** A `TRADING_DRY_RUN` mode runs the entire pipeline — validation,
   guardrails, audit — but **stops before submission** and records "would submit X". This
   is the default even when trading is enabled, until explicitly turned off.
4. **Hard caps, enforced server-side.** Per-order notional, per-symbol max position, max
   open orders, and a **daily realized-loss limit** that halts trading when breached.
   Caps live on the server; the browser can't widen them.
5. **Kill switch.** A single, persisted, prominent "Halt trading" control that immediately
   refuses all new submissions and survives restarts until explicitly cleared.
6. **Idempotency.** Every order intent carries a client-generated key; the same key can
   never submit twice (guards double-clicks, retries, and races).
7. **Full audit trail.** Every intent, validation result, confirmation, submission, and
   broker response is written immutably to SQLite before/after the network call.
8. **Least privilege.** Trading endpoints sit behind the existing auth gate **plus** the
   trading-enabled flag **plus** a confirmation token. Market-data keys and the Webull
   account token stay server-side, as today.
9. **Probe-first integration.** We do **not** guess Webull's trade endpoint shapes. As we
   did for positions/quotes/movers, we confirm every request/response against a real
   read-only probe before writing a mapper or a submit path.

## 3. What already exists we build on (not reinvent)

| Existing piece | Role in trading |
|---|---|
| `server/src/services/riskSizing.ts` | Position size from 1R / stop distance → the **suggested** quantity a ticket pre-fills. |
| `server/src/services/dayGuard.ts` | Daily guardrail logic → feeds the **daily-loss halt** and "should you even be trading today" check. |
| `server/src/services/exposure.ts`, `riskOfRuin.ts` | Portfolio exposure & risk-of-ruin → **pre-trade** exposure ceiling checks. |
| `server/src/options/exitRules.ts` | Exit evaluation → (later phase) suggested bracket/stop legs, still confirm-and-place. |
| `server/src/providers/webull/positions.ts` | Proven **probe-and-confirm** discipline + the `surface: 'trade'` signed client. |
| `server/src/db` (`initDb`/`migrate`) | The migration pattern the new trading tables follow. |
| Auth gate (`requireAuth`) + MFA | The base access control trading sits behind. |

## 4. Architecture

```
web/  Trade surface (distinct, high-friction UI)
  └─ Ticket → Review modal (shows guardrail results) → Confirm → result
        │  always-visible: DRY-RUN badge, kill-switch, daily-risk meter
        ▼
server/ POST /api/trade/* (auth + trading-enabled + confirm-token gated)
  ├─ services/trading/guardrails.ts   pure, fully unit-tested pre-trade checks
  ├─ services/trading/orders.ts       intent lifecycle + idempotency + audit
  ├─ services/trading/killSwitch.ts   persisted halt state
  ├─ providers/webull/orders.ts       signed submit/cancel/status (probe-confirmed)
  └─ db/trading.ts                    order_intents, order_events, trading_config
```

**Why a separate surface, not buttons on existing pages:** trading must *feel* different —
deliberate friction, a different colour, the kill switch and dry-run state always in view.
Embedding "Buy" next to a score invites reflexive clicks; a dedicated surface does not.

## 5. Guardrails (the core)

All checks run **server-side** in `guardrails.ts` as pure functions over `(intent,
accountState, config)`, returning a pass/fail list (mirrored to the UI like the entry-scan
rule breakdown). An order with **any** failed hard rule cannot be confirmed.

**Pre-trade hard rules**
- **Trading armed?** `TRADING_ENABLED` + session-armed + not in dry-run-only.
- **Kill switch off?**
- **Market hours / session** valid for the order type (configurable extended-hours).
- **Per-order notional ≤ cap** (e.g. `$X` and/or `N` shares / `M` contracts).
- **Per-symbol position ≤ cap** after this fill.
- **Account exposure ≤ ceiling** (via `exposure.ts`) and **buying power** sufficient.
- **Daily realized loss < limit** (via `dayGuard.ts`) — else **auto-halt**.
- **Max orders/day** not exceeded.
- **Idempotency key** unused.
- **Fat-finger sanity:** limit price within `±Z%` of last; reject obviously-wrong prices.
- **Options-specific:** strike/expiry currently listed; **no naked short** unless an
  explicit, separately-flagged allowance is on; multiplier sanity.

**Soft warnings (surfaced, not blocking):** earnings before expiry, wide live spread (uses
the new OPRA overlay), low OI/volume, IV-rank context, a buy exceeding settled cash (cash-account
Good Faith Violation risk — §15).

## 6. Order lifecycle

```
draft → validated → (user) confirmed → submitted → ack
                                   └→ rejected            (terminal)
ack → filled | partially_filled | cancelled | expired     (terminal)
```

Every transition is persisted to `order_events` with a timestamp and the raw broker
payload. Submission writes the `submitted` record **before** the network call (so a crash
mid-flight is auditable), then reconciles on the response. A reconcile/poll job confirms
final state and never assumes a fill.

## 7. Data model (new tables, via `migrate()`)

- **`trading_config`** — singleton: `enabled`, `dry_run`, `kill_switch`, caps
  (notional, per-symbol, max orders/day, daily-loss-limit, fat-finger %), allowlist flags.
- **`order_intents`** — id, idempotency_key (unique), symbol, side, type (mkt/limit),
  qty, limit_price, option fields, suggested-size source, state, created_by, timestamps.
- **`order_events`** — intent_id, state, broker_order_id, raw_payload, created_at.

No existing table is modified destructively; journal/positions stay independent (a fill can
*offer* to create a journal position via the existing import path — still user-confirmed).

## 8. Config & secrets

```
TRADING_ENABLED=false        # master switch (server-side)
TRADING_DRY_RUN=true         # simulate submission; default on
TRADING_ACCOUNT_ID=…         # which Webull account may trade
TRADING_MAX_ORDER_USD=…      # hard caps …
TRADING_MAX_DAILY_LOSS_USD=…
TRADING_FATFINGER_PCT=…
```

Webull live trading needs the **account access token** (2FA path) + `account_id` — both
already modelled (`config.webull.accessToken`, account-list probe). Tokens never reach the
browser. `.env` stays gitignored.

## 9. Phased rollout (each phase = its own reviewed PR)

- **Phase 0 — this doc.** Approve the design + the open questions in §11.
- **Phase 1 — read-only trade probes.** Extend the probe panel to confirm the live shapes
  of order **preview**, account **trading status**, and instrument lookups. **No orders.**
- **Phase 2 — dry-run pipeline + full UI.** Intents, guardrails, audit log, Trade surface,
  confirm modal, kill switch, daily-risk meter — all in **dry-run** (records "would
  submit", never calls submit). Exhaustive guardrail unit tests.
- **Phase 3 — live single-order submit.** Flip dry-run off behind tiny caps: one stock and
  one option order, market/limit, with cancel + status reconcile. Manual confirm each time.
- **Phase 4 — convenience (optional).** Suggested bracket/stop legs from the exit-rules
  engine — still confirm-and-place, never auto-fired.

A phase doesn't start until the previous one is merged and you've used it.

## 10. Testing & safety

- Every guardrail gets a unit test (cap boundaries, kill switch, daily-loss halt,
  idempotency double-submit, fat-finger, naked-short block).
  - **Fixed (2026-07-09), naked-short fail-open on the human place/replace path.** A
    hardening audit found the `naked_short` (and `position_size`) check read
    `webullAccountState`'s per-**underlying** aggregate, which sums stock AND every
    option contract on a symbol. So being long 100 shares of a name let a single-leg
    option SELL-to-open on that name pass even with `allowNakedShort=false` — long
    stock does not cover a short option, and a different strike/expiry is a different
    instrument. `webullAccountState` now takes an optional `instrument` and counts only
    the matching instrument (this exact option contract, or stock); `placeOrder` /
    `replaceOrder` pass the order's own contract. The autotrade loop was already clear
    (long-only equity entries; the single-leg options close feeds its own ledger
    quantity via `currentPositionQtyOverride`; equity has no live sell path).
  - **Fixed (2026-07-09), account-state positions fail-open.** `webullAccountState`
    returned `ok:true` with `currentPositionQty:0` when the balance call succeeded but
    the positions call failed — a fabricated 0 that under-counts a real holding for the
    `position_size` cap. It now sets `positionsUnavailable`, and `placeOrder` /
    `replaceOrder` fail CLOSED on it (block rather than size against an unknown
    position). Autotrade is unaffected (it doesn't consult the flag: long-only entries,
    or a close that supplies its own ledger quantity).
  - **Fixed (2026-07-09), fat-finger client-weakenable + missing for stop-limits.**
    `referencePrice` was a client field, so a hand-crafted request could omit it
    (downgrading `fat_finger` to a warning) or set it equal to an absurd limit
    (deviation 0). `placeOrder` now re-derives the reference SERVER-side from a fresh
    stock quote (cache-resilient; a market-data miss falls back to the client value) and
    overrides it before the guardrails — options keep the client mark for now (a
    per-contract chain fetch on the place path is heavier; the confirmed case was stock).
    Separately, `stop_loss_limit` had NO fat-finger check; the guardrail now checks a
    stop-limit's limit against its OWN stop (not the market, which the stop is
    deliberately away from). Autotrade already sets `referencePrice` server-side, so it's
    unaffected.
  - **Fixed (2026-07-09), a human-placed bracket's exit leg was never reconciled —
    reported against two real symbols that stayed "open" long after their stop/target
    actually filled.** Root cause: `order_intents.state` reflects only the bracket's
    MASTER (entry) leg — it reads `filled` the instant the entry fills and, since
    `filled` is terminal, never moves again, even while a linked STOP_LOSS/STOP_PROFIT
    exit leg is still working at the broker. `services/trading/reconcile.ts`'s
    `reconcileIntent`/`reconcileAllWorking` (the human "Refresh status"/"Refresh all"
    path) short-circuited on that terminal state and never looked at `broker.legs` at
    all — so a bracket's exit was undetectable there no matter how many times "Refresh
    all" was clicked. (`autotrading/liveExecute.ts`'s own `reconcileOneLiveOrder` already
    had this exit-leg check for the autotrade path — the gap was specific to the human
    path.) Fixed by keeping a filled bracket "pending" in `reconcileIntent` as long as its
    position is still open (mirrors `autotradeLiveOrders.ts`'s `listPendingLiveOrders`
    logic), then checking `broker.legs` for a leg unambiguously identified as non-MASTER
    and FILLED (same fails-closed posture — ambiguous or still-working leaves the position
    open rather than guessing) and recording the exit priced from THAT leg specifically
    (not the entry's own fill price). A subtlety: `recordCloseAsExit` infers which
    position side to reduce from the closing order's own `side` — but a bracket's exit
    leg is still the SAME entry intent (`side`/`openClose` never changed from
    `buy`/`open`), so a synthetic side-flipped copy is passed in rather than the
    intent's own fields, or the inference lands backwards.
  - **Fixed (2026-07-09), no automatic reconciliation for human-placed live orders at
    all.** `reconcileAllWorking` only ever ran on a manual "Refresh all" click — unlike
    autotrade's own always-on 60s loop, nothing polled a human-confirmed live order's
    status in the background. New `services/webullPositionsScheduler.ts` (mirrors
    `alertScheduler.ts`'s self-scheduling pattern) runs `syncWebullAccount()` — order
    reconcile (including the bracket-exit fix above), then a position-**truth** check
    (`providers/webull/positions.ts`'s `syncClosedWebullPositions`/
    `runWebullPositionsSync`) that diffs the journal's open quantity per contract against
    Webull's actual live holdings and closes the gap (FIFO, priced from the latest
    quote/mark since there's no fill to read a price from — skipped, not guessed at $0, if
    pricing fails) to catch anything still unattributable to a known order (e.g. sold
    directly in the Webull app, bypassing this app's order flow entirely), then imports
    anything new. Scoped to positions tagged `webull`/`live` or linked to a live
    `order_intent` — never a plain manually-logged position, which could be tracked at a
    different broker entirely. Enabled by default once an account id is set on Settings;
    also available on-demand via a "Sync now" button.
  - **Fixed (2026-09-06), every live option price was rounded to the cent, and Webull
    demands NICKELS under $3 of premium.** The broker rejects the order outright: _"The
    limit price increment is not correct. Orders placed with a premium of less than $3
    must be in increments of 0.05."_ All four price sites in `liveOptionsExecute.ts` used
    `Math.round(x * 100) / 100`, and `priceStr()` in `providers/webull/orders.ts` — the
    backstop that exists precisely so a tick rejection cannot reach the broker — rounds to
    the cent too, because it was written for equities, where the cent IS the grid. The one
    live options position this app has ever taken is the whole case study: SRAD opened
    2026-08-03 at a `1.05` limit (a nickel multiple by luck) and then could not be closed
    — three exit attempts on 08-04 were rejected with that exact string, the position sat
    unmanaged for seventeen days, and on 08-21 the broker sync noticed it was simply gone
    and booked **-$87 from an ESTIMATED price, not a confirmed fill**. New
    `services/trading/optionTick.ts` is the single grid authority: round to the nearest
    cent first (float hygiene, byte-identical to the old behaviour at/above $3), then snap
    a sub-$3 price onto the nickel **toward filling** — a BUY limit up, a SELL limit down —
    so making an order placeable can never make it less likely to fill. Applied at all four
    live sites ahead of the guardrails (so the notional and buying-power caps see the price
    that is actually sent) and again in the option order builders as a backstop.
  - **Fixed (2026-09-06), the fat-finger check refused the only sayable price on a cheap
    option.** A percentage is the wrong unit at the bottom of the price scale: an option
    under $3 quotes in nickels, so on a $0.20 mark the nearest expressible step down is
    `0.15` — 25% off, and `fat_finger` (10% in production) blocked it. The tick rounding
    above would have traded a broker rejection for a guardrail rejection one layer up. A
    deviation of **at most one tick** — a nickel for a sub-$3 option, a cent otherwise — is
    now never a fat finger, whatever percentage it works out to; anything beyond a tick is
    still judged on the percentage. Caught by an existing test rather than in production,
    which is the point of asserting at the consumer.

- The submit path is **never** exercised against the live broker in tests — `fetch` is
  mocked, exactly as the existing Webull tests do.
- A "panic" test: kill switch on ⇒ every submit refuses.
- CI stays green on the same `format/typecheck/lint/test/build` gate; trading code is dead
  weight until `TRADING_ENABLED` is set in the deployed env.

## 11. Open questions (need your call before Phase 1)

1. **Scope:** stocks + single-leg options only to start? (Recommend: yes.)
2. **Caps:** starting values for max order $, max daily loss $, max orders/day, fat-finger %?
3. **Options shorting:** keep **naked short blocked** entirely at first? (Recommend: yes.)
4. **Account:** which Webull `account_id`, and is it a margin or cash account?
5. **2FA token:** are you on the access-token (2FA) path, and how do you want it refreshed?
6. **Paper trading:** does your Webull OpenAPI plan expose a paper/sandbox account we can
   point Phase 3 at before real money? (If yes, that becomes the default first target.)

## 12. Explicit non-goals

No algorithmic/automated/scheduled trading. No signal-fired entries or exits. No
copy-trading, no HFT, no order-flow gimmicks. The app remains decision-support that can,
with deliberate human confirmation and hard limits, place a single reviewed order — and
nothing more.

---

## 13. Decisions (§11 answered) — 2026-06-25

| Question | Decision |
|---|---|
| Scope | **Stocks + single-leg options** first. |
| Caps | Use conservative starting caps, tunable in the Trade UI. Recommended start: **max order $1,000**, **max daily loss $500**, **max orders/day 10**, **fat-finger 10%** (engine defaults are even smaller). |
| Naked short | **Blocked.** (`allowNakedShort` stays false.) |
| Account | **Cash account.** |
| 2FA / access token | **Off** for now; signature-only auth. Keep an **option to enable** the `x-access-token` (2FA) path later — already supported by the client. |
| Paper/sandbox | **None — go straight to the real account.** ⇒ extra caution: tiny caps, dry-run first, manual confirm on every order, kill switch in reach. |

## 14. Confirmed Webull Trading API (from the official docs)

Endpoint **paths are not in the user-facing docs** (the SDK abstracts them); they are
confirmed/guessed below and must each be **probe-confirmed against the real account**
before any mapper or submit path is built — same discipline as positions/quotes.

**Hosts / prefixes.** Account reads use `/openapi/account/list` and
`/openapi/assets/{balance,positions}` (already wired). Orders live under
**`/openapi/trade/order/*`** — confirmed paths + methods from the API Reference:

| Endpoint | Method | Path | Side effect |
|---|---|---|---|
| Preview | POST | `/openapi/trade/order/preview` | none (cost estimate) |
| Place | POST | `/openapi/trade/order/place` | **places an order** |
| Replace | POST | `/openapi/trade/order/replace` | modifies an order |
| Cancel | POST | `/openapi/trade/order/cancel` | cancels an order |
| Open orders | GET | `/openapi/trade/order/open` | none (read) |
| Order history | GET | `/openapi/trade/order/history` | none (read) |
| Order detail | GET | `/openapi/trade/order/detail` | none (read) |
| Stock instruments | GET | `/openapi/instrument/stock/list` | none (read) |

(The Signature doc's `/trade/place_order` was an older example; the v2 path is
`/openapi/trade/order/place`. `/trade/open_orders` 404'd as expected.)

**Account flow (read-only, paths confirmed):** `Account List` → pick the **cash**
`account_id` (response carries `account_id` + `account_type`); `Account Balance`
(buying power / cash); `Account Positions` (holdings). Rate limits: balance/positions
2/2s, list 10/30s.

**Order lifecycle:** Preview → Place → Replace → Cancel → Query (history / open / detail).
- **Preview Order** ("estimate costs before placing", 150/10s) — **does not place**; the safe pre-submit cost check.
- **Place Order** (`/trade/place_order`, 600/60s) — takes an **array** of order objects.
- **`client_order_id`** — caller-generated, **unique per account, max 32 chars** (use a UUID); this is the broker-side idempotency key (maps to our intent's idempotency key).
- Real-time fills/cancels come via a **gRPC Trade Event Subscription** (out of scope for v1; we'll poll Order Detail / Open Orders instead).
- No extra OpenAPI fees; same schedule as the app.

**Stock order body (confirmed):**
`{ combo_type:"NORMAL", client_order_id, symbol, instrument_type:"EQUITY", market:"US",
order_type:"LIMIT"|"MARKET"|"STOP_LOSS"|"STOP_LOSS_LIMIT", side:"BUY"|"SELL"|"SHORT",
quantity, limit_price?, stop_price?, time_in_force:"DAY"|"GTC", entrust_type:"QTY"|"AMOUNT",
support_trading_session:"CORE"|"ALL"|"NIGHT" }`. Fractional via `entrust_type:"AMOUNT"` +
`total_cash_amount`. **Unlike options below, stock GTC is NOT buy-side-only** — confirmed
against Webull's own API docs, both sides support GTC for equities. `bracketExit()`
(`providers/webull/orders.ts`) uses this: a stock bracket's SELL-side exit legs (stop-loss +
take-profit, closing a long) are GTC, not DAY — fixed 2026-07-13 after DAY exit legs were
found silently expiring unfilled at the close, leaving the position open with no resting
stop and nothing detecting or re-arming it. GTC itself auto-expires after 90 calendar days
(not unlimited), so `maxHoldDays` is still worth setting as a backstop.

**Single-leg option order:** same unified endpoint with `instrument_type:"OPTION"`,
`option_strategy:"SINGLE"`, and a **`legs`** array (strike / expiration / option type /
side / quantity). Options support **LIMIT / STOP_LOSS / STOP_LOSS_LIMIT only** (no MARKET,
no TRAILING, no SHORT); **sell-side is DAY-only** (GTC is buy-side only) — this DOES apply
here, unlike stock above, so an options bracket's exit legs (`optionBracketExit()`) can't
use the same GTC fix; they still expire DAY-TIF, a known, currently-unaddressed gap.

**Mapping to our engine:** our `OrderIntent` (side/openClose/qty/orderType/limitPrice +
option fields) covers the stock and single-leg-option bodies; `LIMIT`/`MARKET` map directly,
`support_trading_session` comes from a regular/extended toggle, and our intent's idempotency
key becomes `client_order_id`.

## 15. Status (shipped)

- **Phase 1 (read-only):** `Account List` (cash account_id `…INDIVIDUAL_CASH`), `Balance`
  (→ `AccountState` mapper / "Pull from Webull"), `Positions`, and the
  `/openapi/trade/order/{open,history}` probes.
- **Phase 2 (no broker):** guardrails engine, config + kill-switch persistence, order-intent
  model + lifecycle, dry-run pipeline, the Trade UI.
- **Phase 3 (LIVE — shipped):** `livePreview` (real account-state → guardrails →
  `/openapi/trade/order/preview` cost estimate; places nothing) and `placeOrder` →
  `/openapi/trade/order/place`. Placing requires **all** of: `TRADING_ENABLED` env (deploy
  gate) + a server-checked type-to-confirm phrase + every guardrail passing against fresh
  account state + the kill switch off. Each attempt is walked through the lifecycle and
  written to the audit trail (with the broker `order_id` on success).
- **Sessions:** the order carries a `session` (`core`/`extended`/`overnight`) → Webull
  `support_trading_session` (`CORE`/`ALL`/`NIGHT`). A `session_order_type` guardrail blocks
  market orders outside regular hours (the broker only accepts limit orders there).
- **Status reconcile (shipped):** confirmed the live order envelope from a real fill —
  `{ client_order_id, combo_order_id, orders:[{ status, order_id, filled_quantity, filled_price … }] }`.
  `reconcileIntent` pulls an order by its `client_order_id` (open orders → history) and advances
  acknowledged → `filled`/`partially_filled`/`cancelled`/`expired`, audited. Surfaced as
  **Refresh status** in the Trade "Orders" panel. Read-only toward the broker.
- **Cancel (shipped):** `cancelIntent` POSTs `/openapi/trade/order/cancel` (body
  `{ account_id, client_order_id }`) for an order still live at the broker, then reconciles to the
  resulting terminal state. Risk-reducing, so it is **not** gated by `TRADING_ENABLED`. Surfaced as
  **Cancel** in the "Orders" panel. (Request body keyed on `client_order_id`; confirm against a
  live open order.)
- **Replace (shipped):** `replaceIntent` POSTs `/openapi/trade/order/replace` (body
  `{ account_id, modify_orders:[{ client_order_id, quantity?, limit_price?, stop_price? }] }`, per
  the docs' `modify_orders` example) to change a working order's qty/limit/stop. A replace can
  _increase_ exposure, so it IS gated like placing: `TRADING_ENABLED` + the guardrails re-run on
  the modified order. On accept it persists the new qty/limit (`recordReplace`) + an audit event,
  then reconciles. Surfaced as **Modify** in the "Orders" panel. (Confirm against a live open order.)
- **Single-leg options (shipped):** preview + place handle `assetKind:'option'` via the SAME
  unified endpoint as stocks (`instrument_type:'OPTION'`). `buildWebullOptionOrder` matches the
  official "Buy Call (Limit)" example from the Options Trading API docs:
  `{ client_order_id, combo_type:'NORMAL', order_type:'LIMIT', limit_price, quantity,
  option_strategy:'SINGLE', side, time_in_force:'DAY', entrust_type:'QTY',
  instrument_type:'OPTION', market:'US', symbol, legs:[{ side, quantity, symbol, strike_price,
  option_expire_date, instrument_type:'OPTION', option_type, market:'US' }] }`. `side`, `market`
  and `symbol` are carried at the **order level AND repeated on the leg**; there is **no**
  `position_intent` (the broker derives it) and no `support_trading_session`. (Live previews
  surfaced this one validated field at a time: "invalid side" → order-level side; "invalid
  market" → the leg's `market`.)
- **Order types (shipped):** `market` / `limit` / `stop_loss` (market-on-trigger) /
  `stop_loss_limit` (limit-on-trigger). `order_type` maps to MARKET/LIMIT/STOP_LOSS/
  STOP_LOSS_LIMIT; `stop_price` is sent for stop types, `limit_price` for limit + stop-limit.
  Guardrails: `stop_price` (stops need a positive trigger), `limit_price` (limit + stop-limit
  need a positive limit), and `option_order_type` (options support LIMIT/STOP_LOSS/
  STOP_LOSS_LIMIT — **no MARKET**).
- **Brackets (shipped, stocks):** a stock limit entry can carry an optional take-profit and/or
  stop-loss. `buildOrderRequest` emits the docs' bracket shape — `client_combo_order_id` +
  `new_orders:[ MASTER (entry LIMIT), STOP_PROFIT (exit LIMIT @ take-profit), STOP_LOSS (exit
  STOP_LOSS @ stop) ]`, the exits on the opposite side. A `bracket_prices` guardrail blocks an
  inverted take-profit/stop pair (and non-stock / non-limit brackets). Preview + place go through
  the same `buildOrderRequest`, so a bracket previews as a unit.
- **Vertical spreads (shipped):** `optionStrategy:'VERTICAL'` + `optionLegs[2]`. `buildWebullOptionOrder`
  emits `option_strategy:'VERTICAL'`, order-level net `side`/`limit_price`/`symbol`, and the 2-leg
  array (same envelope as the confirmed COVERED_STOCK example). A `spread_legs` guardrail requires
  exactly 2 legs (same expiry, distinct strikes, one buy + one sell, equal qty); the spread is
  valued at the NET (`limitPrice × 100 × qty`) and the single-leg naked-short / position-size rules
  are skipped (defined-risk). NB: the docs scrape only serialized the SINGLE + COVERED_STOCK
  examples, so the VERTICAL order-level shape is **inferred from COVERED_STOCK and confirmed via a
  live preview** before placing.
- **Cancelling a resting bracket post-fill (2026-07-11, autotrade's maxHoldDays
  force-close — UNCONFIRMED, needs a real live trade):** every prior use of Cancel
  (above) targets an order still working/unfilled. This is new, different territory:
  `autotrading/liveExecute.ts`'s `checkLiveEquityTimeExits()` calls
  `webullCancelOrder(accountId, entryIntent.idempotencyKey)` — the MASTER leg's own
  client_order_id — AFTER that leg is already `filled`, on the working theory that
  cancelling by any one id belonging to the `client_combo_order_id` group reaches the
  whole combo, including the still-resting STOP_LOSS/STOP_PROFIT legs. Never trusted
  blindly: always re-polls Order Detail/Open Orders immediately after and requires
  every non-MASTER leg to unambiguously show as no longer resting before proceeding —
  anything short of that (including a leg that raced the cancel and already filled)
  fails closed, leaving the position open for the next cycle to retry. If a real
  account confirms this doesn't work as theorized, the fallback would be resolving
  each leg's own broker-assigned `order_id` from Order Detail and cancelling by that
  instead (untried — no confirmed evidence Webull's cancel endpoint accepts an
  `order_id` in place of `client_order_id`).
  **The theory above was WRONG — confirmed against a real account (2026-07-16).**
  Cancelling by the MASTER's `client_order_id` does NOT reach the resting exit legs:
  a bracket's STOP_LOSS/STOP_PROFIT legs each get their OWN `client_order_id` at
  placement (`buildOrderRequest`), which was never persisted, and the master-id cancel
  only ever touches the already-filled master. A human hit this exactly: a manual
  **Close** got past the (now-benign) cancel step but the broker then rejected the
  close order itself — _"this order cannot be entered because it will reverse an
  existing position … cancel an open order"_ — because the stop/target were still
  live. Cancelling them by hand in the Webull app unblocked the close.
  **Rewritten to scan-and-cancel (`cancelLiveBracketExitLegs`, 2026-07-16):** it no
  longer trusts the master-id cancel or the combo-status re-poll to find the exit legs.
  Instead it reads the broker's live open orders (`listWebullOpenOrders` — a new
  read-only, lenient-parsing list of every resting order) and finds the ones on THIS
  symbol on the EXIT side (a long's stop/target are sells, the same side as the close),
  cancels each by its OWN `client_order_id`, then RE-SCANS and confirms none remain
  before letting the close through — exactly what the manual fix did. This is the
  "resolve each leg's own id and cancel by that" fallback the note above anticipated,
  driven off the open-orders list rather than persisted ids (so it also clears
  already-open positions whose leg ids we never saved). Fail-closed throughout: it
  places a close only after confirming no same-side order is still resting; if the
  open-orders read fails, or an order still rests after cancel, or (best-effort, via the
  combo status) an exit leg is seen FILLED, it blocks rather than risk a double-fill.
  Side must be POSITIVELY parsed to be cancelled, so a wrong-side or unparseable order
  is never touched. A one-line `console.warn` breadcrumb logs what the scan matched (and
  a truncated raw sample when it matched nothing on a non-empty list) so the first live
  run reveals any remaining field-name mismatch. Applies to both callers unchanged: the
  maxHoldDays force-close and the human Positions-page close.
- **Manually closing a REAL position from the Positions page (shipped, 2026-07-16):**
  `POST /api/positions/:id/close` (`services/trading/closePosition.ts`) — the human-confirmed
  counterpart to autotrade's own force-closes above. Fixes a real gap: the pre-existing
  **exit** action (`POST /:id/exits`) only ever wrote a journal entry, silently doing nothing
  toward the broker for a live position (tagged `webull`/`live`, or with a `sourceIntentId`) —
  the app would show it as closed while the broker still held it. The Positions page now shows
  **close**, not **exit**, for any such position, opening a modal with the SAME
  type-to-confirm-phrase friction (`SELL <qty> <symbol>` / `BUY <qty> <symbol>`, flipped from the
  position's side) as any other live order. Server-side: checked BEFORE anything else (a mismatch
  has zero side effects, not even a bracket cancel); if the entry intent was a bracket, its
  resting exit legs are cancelled first via the SAME `cancelLiveBracketExitLegs` this file's own
  post-fill-cancel entry above uses; then a fresh marketable-limit closing order (0.5% buffer,
  full remaining quantity) is submitted through `placeOrder()` — the identical
  `TRADING_ENABLED` + guardrails + audit-trail pipeline the Trade page itself uses, not a
  parallel implementation. The resulting order is a plain, non-autotrade-tagged intent, so the
  EXISTING generic reconcile (`reconcileIntent`/`reconcileAllWorking`, including the background
  Webull sync scheduler) picks up its fill and records the exit — no new reconciliation code
  needed. One exception: for an autotrade-tagged EQUITY position specifically, the resulting
  intent IS registered with autotrade's own bookkeeping (`recordLiveExitOrder`), so
  `checkLiveEquityTimeExits`'s own maxHoldDays dedup guard sees the close already in flight and
  doesn't independently race it with a second cancel+close attempt — never needed for options,
  since autotrade's live options positions live in an entirely separate table never shown on the
  Positions page.
- **Expanding manual close to autotrade's own live positions (shipped, 2026-07-16):** the
  Positions-page close above only reaches positions returned by `GET /api/positions` — autotrade's own
  live EQUITY positions (tagged `autotrade`, same generic `positions` table) already worked there
  unchanged, so the Auto-Trade page's own live positions table just got a **close** button reusing the
  exact same `CloseModal` / `closeLivePosition` / `POST /positions/:id/close` path, no new server code.
  Autotrade's live OPTIONS positions, though, live in a separate table
  (`autotrade_live_options_positions` — a debit spread's second leg has no column for it on `positions`),
  so this needed its own service (`closeLiveOptionsAutotradePosition`), route
  (`POST /api/autotrade/live-options-positions/:id/close`), and modal
  (`CloseLiveOptionsPositionModal`, Auto-Trade page). Same confirmation-first, human-confirmed
  `placeOrder()` pipeline as the equity case — never autotrade's own no-confirmation
  `placeLiveOptionsExit` internals. Every autotrade options position is opened LONG, so the close is
  always a sell: single_leg is a plain sell-to-close; debit_spread is a VERTICAL combo selling the long
  leg and buying back the short leg, net-priced from BOTH legs' fresh marks. No bracket-cancel step —
  autotrade's options signals never carry one. `placeOrder()` needed no changes: its own
  `webullAccountState()` call already filters to the exact contract via `matchesInstrument()` for a
  single-leg close, and a VERTICAL close skips the naked-short/position-size checks entirely as a
  multi-leg order (`guardrails.ts`'s `isMultiLeg`) — so neither case needs the
  `currentPositionQtyOverride` workaround `liveOptionsExecute.ts`'s own unfiltered 2-arg
  `webullAccountState()` call requires for its autonomous exit path.
- **`exit_reason` threaded from a manual close through to the closed position (shipped, 2026-07-16):**
  unlike equity (whose `PositionExit` has no stored exit-reason field), a live options position's
  `exitReason` IS a stored, UI-rendered field (the Auto-Trade page's Live options positions table
  badge) — so a manually-closed position showing "time exit" would be a real, visible, incorrect label,
  not just a cosmetic log imprecision. Fixed with a new nullable `exit_reason` column on
  `autotrade_live_options_orders` (idempotent `ALTER TABLE`; pre-existing rows read `NULL`).
  `recordLiveOptionsExitOrder`'s `exitReason` param is now REQUIRED, not defaulted, so both callers —
  `checkLiveOptionsExits`' own time-exit trigger (`'time_exit'`) and the manual close above (`'manual'`)
  — stay explicit about which one placed the order. `materializeOptionsExitFill` reads it back
  (`meta.exitReason ?? 'time_exit'`, the fallback covering only a pre-migration pending row) once it
  finally closes the position, instead of always hardcoding `'time_exit'`.
- **`settled_cash` guardrail — cash-account Good Faith Violation warning (shipped, 2026-07-19):**
  Webull's `/openapi/assets/balance` response includes `account_currency_assets[0].settled_cash`
  (confirmed alongside `buying_power`/`option_buying_power` — same object, see §14), previously
  fetched and discarded. `webullAccountState()` now parses it into `AccountState.settledCashUsd`
  (`undefined`, not a fabricated 0, when the broker omits it — a missing field must skip the
  check, not warn blind). A new `settled_cash` guardrail (soft warning, like `market_hours`) fires
  when a BUY's notional exceeds settled cash: this account is a cash account (§13), which risks a
  **Good Faith Violation** if a position bought with proceeds that haven't cleared T+1 yet is sold
  again before that funding trade settles. Deliberately NOT a hard block — exact GFV detection
  needs per-lot settlement-date tracking this app doesn't keep, and a wrong block would suppress
  ordinary, legal cash-account activity; a warning surfaces the risk instead of guessing at it.
  (PDT was considered and explicitly rejected: FINRA eliminated the classic Pattern Day Trader
  rule effective June 4, 2026, and it only ever applied to margin accounts — never this app's cash
  account — so a PDT guardrail would have been a check against a rule that no longer exists, for
  an account type it never covered.)
- **Next:** confirm a real option fill + a real vertical preview; COVERED_STOCK (stock+option) and
  IRON_CONDOR (4-leg) strategies; options brackets / OTOCO; the post-fill bracket-cancel
  behavior above against a real account.
