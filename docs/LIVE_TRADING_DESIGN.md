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
