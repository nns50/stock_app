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
the new OPRA overlay), low OI/volume, IV-rank context.

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
`total_cash_amount`.

**Single-leg option order:** same unified endpoint with `instrument_type:"OPTION"`,
`option_strategy:"SINGLE"`, and a **`legs`** array (strike / expiration / option type /
side / quantity). Options support **LIMIT / STOP_LOSS / STOP_LOSS_LIMIT only** (no MARKET,
no TRAILING, no SHORT); **sell-side is DAY-only** (GTC is buy-side only).

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
- **Single-leg options (shipped):** preview + place now handle `assetKind:'option'`.
  `buildWebullOrder` dispatches to `buildWebullOptionOrder` →
  `{ instrument_type:'OPTION', option_strategy:'SINGLE', side, position_intent, legs:[{ symbol,
  side, quantity, option_type, strike_price, option_expire_date }] }`. `position_intent` =
  side × open/close (BUY_TO_OPEN / SELL_TO_CLOSE / SELL_TO_OPEN / BUY_TO_CLOSE). An
  `option_limit_only` guardrail blocks market options. A live preview confirmed Webull validates
  `side` at the **order level too** (not only on the leg) — without it, preview returns
  "Parameter error, invalid side".
- **Next:** confirm a real option fill end-to-end; bracket/stop legs (`combo_type`
  STOP_LOSS / STOP_PROFIT, `stop_price`); order replace.
