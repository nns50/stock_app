import { db } from './index';

// ---------------------------------------------------------------------------
// Persistence for the auto-trading master switch + active risk profile (see
// docs/AUTOTRADING_SPEC.md — Risk Profiles). Stored as one JSON row, same
// singleton-upsert shape as trading_config (db/trading.ts), so adding a field
// later needs no migration.
//
// This only stores settings — it does NOT run the execution loop or evaluate
// risk. `enabled` here is scoped to the auto-trading loop specifically; it is
// independent of the live-trading TRADING_ENABLED env gate and kill switch
// (db/trading.ts), which guard the human-confirmed order pipeline this loop
// will eventually place orders through.
// ---------------------------------------------------------------------------

export type RiskProfileName = 'MODERATE' | 'AGGRESSIVE';

/** Which options strategy shape the loop builds (docs/AUTOTRADING_SPEC.md,
 *  phase 9/10's own deferred "debit spread" follow-up). 'single_leg' (long
 *  call/put) by default — a debit spread caps both max loss AND max gain, a
 *  genuinely different risk/reward trade a human should opt into explicitly,
 *  not something the loop silently switches to based on market conditions. */
export type OptionsStrategyType = 'single_leg' | 'debit_spread';

export interface AutotradeConfig {
  /** Master on/off for the auto-trading execution loop. */
  enabled: boolean;
  /** Sticky emergency halt (docs/AUTOTRADING_SPEC.md — Phase 7's resolved kill-switch
   *  decision), independent of `enabled` — mirrors db/trading.ts's TradingConfig.killSwitch.
   *  Engaging it blocks new entries immediately; it does NOT force-close open paper
   *  positions (see loop.ts — checkPaperExits() always runs regardless of this flag, since
   *  in paper mode this loop IS the only thing that can enforce an already-open position's
   *  stop/target). Independent of `enabled` so releasing it resumes the loop automatically
   *  without the user needing to re-arm "enabled" too. */
  killSwitch: boolean;
  /** Active risk profile. Defaults to MODERATE; switching to AGGRESSIVE is
   *  gated by an explicit confirmation at the route (see routes/autotrade.ts). */
  riskProfile: RiskProfileName;
  /** Account equity (USD) the risk engine sizes trades and computes its %
   *  caps against. No live broker balance is wired in yet (see
   *  services/autotrading/riskCheck.ts) — set this manually. Null until set;
   *  the risk engine fails closed (blocks everything) while it's unset. */
  accountEquityUsd: number | null;
  /** ONE combined budget for open positions — equity and options positions
   *  share this same pool (see services/autotrading/optionsRiskCheck.ts's
   *  header comment on why: the spec calls for one combined risk budget, not
   *  separate pools). Used to live baked into RiskProfileParams, swinging with
   *  MODERATE/AGGRESSIVE; now directly configurable so switching profile
   *  doesn't silently change a cap the user explicitly set. */
  maxConcurrentPositions: number;

  // --- Risk-check parameters (docs/AUTOTRADING_SPEC.md — RISK PROFILES).
  // Every field below used to live in riskProfiles.ts's MODERATE/AGGRESSIVE
  // preset table, swinging whenever riskProfile changed. Moved out
  // 2026-07-10, same treatment (and same reasoning) as maxConcurrentPositions
  // above — reported directly: raising maxConcurrentPositions alone (to 15)
  // didn't unblock new entries with only 2 positions open, because
  // maxAggregateOpenRiskPct — 2% of equity at the old MODERATE preset, about
  // 2 positions' worth of risk at 1%/trade — was the one actually binding,
  // and had no independent lever at all. Defaults below match the old
  // MODERATE preset exactly, so an untouched config's behavior doesn't
  // change; riskProfile itself no longer has ANY computational effect on
  // these (see riskProfiles.ts's header comment) — it's kept purely as a
  // label (still gates the AGGRESSIVE-switch confirmation dialog). ------

  /** % of account equity risked per trade (before any step-down cut). */
  riskPerTradePct: number;
  /** % daily drawdown (of equity) that halts new entries for the rest of the day. */
  maxDailyDrawdownPct: number;
  /** Consecutive losing trades that trigger step-down sizing. */
  stepDownAfterLosses: number;
  /** % cut to riskPerTradePct once step-down is active. */
  stepDownSizeCutPct: number;
  /** % of equity — sum(size × stop distance) across open + proposed
   *  positions (the CRITICAL pre-trade check — see riskCheck.ts). ONE
   *  combined budget shared by equity + options, same pool as
   *  maxConcurrentPositions above. */
  maxAggregateOpenRiskPct: number;
  /** % of equity — capital (not risk) already concentrated in tickers
   *  statistically correlated (|r| ≥ 0.7 over 30 trading days —
   *  riskProfiles.ts's CORRELATION_THRESHOLD/CORRELATION_LOOKBACK_DAYS,
   *  still fixed methodology constants, not user-tunable) with the candidate. */
  maxCorrelatedExposurePct: number;
  /** Max entries (paper + live combined) risk-check will approve per day. */
  maxTradesPerDay: number;

  // --- Screening/decision thresholds (docs/AUTOTRADING_SPEC.md — RESEARCH &
  // SCREEN / DECISION). Same treatment, extraction, and reasoning as the
  // risk-check parameters above, added 2026-07-11: these lived as hardcoded
  // constants (screen.ts's defaultAutotradeScreenerConfig(),
  // executionGuards.ts's defaultVolatilityFilterConfig(), decide.ts's
  // defaultDecisionConfig(), loop.ts's SESSION_BUFFER_MINUTES) with no way to
  // tune them at all — a structurally different category from the risk-check
  // fields (these gate what counts as a candidate and how it's priced, not
  // how a signal is sized/capped once found). Defaults below match those
  // constants exactly, so an untouched config's behavior doesn't change.
  // loop.ts threads these through explicitly on every tick; the manual
  // Screen/Decision preview routes (routes/autotrade.ts) default to them too
  // (so the preview matches what the loop would actually do) but can still
  // be overridden ad hoc per request, same convention as before. Backtesting
  // keeps using screen.ts's/decide.ts's own static legacy defaults unless a
  // request explicitly overrides via its existing screenerConfig/
  // decisionConfig fields — mirrors the risk-check fields' own backtest
  // treatment exactly. maxTickerAtrPct/maxMarketAtrPct/sessionBufferMinutes
  // have no backtest equivalent at all (a historical daily-bar replay has no
  // real-time session clock or same-day volatility guard to simulate).

  /** Screener's relative-volume floor (× average volume) — auto-trade leans
   *  harder on "unusual volume" than the manual screener's general-purpose
   *  default. 0 disables this specific filter (every relative-volume reading
   *  passes). */
  minRelVol: number;
  /** Skip a candidate whose own ATR% (of price) exceeds this — the loop's
   *  own per-ticker volatility guard, stricter than what the human-reviewed
   *  manual Screen/Decision preview applies (executionGuards.ts's header
   *  comment on why: an unattended loop has no one to override a bad read). */
  maxTickerAtrPct: number;
  /** Skip ALL new entries this cycle if the broad-market proxy's (SPY) own
   *  ATR% exceeds this. */
  maxMarketAtrPct: number;
  /** Stop distance = this × the candidate's own ATR. */
  stopAtrMultiple: number;
  /** Target distance = stop distance × this (a reward:risk multiple). */
  targetRMultiple: number;
  /** No new entries within this many minutes of the session open or close —
   *  the opening auction and closing imbalance both distort prices in ways a
   *  signal shouldn't react to. */
  sessionBufferMinutes: number;

  // --- Phase 8: live-trading gate (docs/AUTOTRADING_SPEC.md) -----------------

  /** Master on/off for the loop placing REAL orders through Webull. False by
   *  default. Paper execution (execute.ts, autotrade_paper_positions) is
   *  completely independent of this flag and keeps running either way — this
   *  only gates the separate live path (Phase 8 Step B). Setting this false
   *  -> true requires the exact confirmLiveTrading phrase at the route
   *  (routes/autotrade.ts) — confirmed decision: a one-time, deliberate
   *  gesture per enable, not per-order friction. */
  liveTradingEnabled: boolean;
  /** Epoch ms of the most recent false -> true transition of
   *  liveTradingEnabled, or null if never enabled. Anchors the probation
   *  window (liveProbationTrades): how many trades count as "still in
   *  probation" is DERIVED from real order_intents created at/after this
   *  timestamp (Step B), never a separately-incremented counter that could
   *  drift from what was actually placed. */
  liveEnabledAt: number | null;
  /** The Webull cash account_id the live loop places orders against —
   *  server-side only. The human Trade page sources its accountId from
   *  browser localStorage, which has no meaning for an unattended process;
   *  this is set once here instead. Live trading can't be enabled while this
   *  is unset (fails closed, same posture as accountEquityUsd). */
  liveAccountId: string | null;
  /** Guardrail caps for autotrade's OWN live orders (services/trading/
   *  guardrails.ts's evaluateGuardrails(), called with this config instead of
   *  db/trading.ts's human-tuned TradingConfig) — deliberately a separate cap
   *  set, since autotrade sizes risk-based (% equity × stop distance), which
   *  can imply a different notional than the human page's flat caps were
   *  tuned around. See suggestLiveCaps() for the equity-derived starting
   *  formula; freely editable afterward. */
  liveMaxOrderUsd: number;
  liveMaxDailyLossUsd: number;
  liveMaxOrdersPerDay: number;
  liveFatFingerPct: number;
  /** Defaults false, matching guardrails.ts's own default and this project's
   *  defined-risk-by-default posture. */
  liveAllowNakedShort: boolean;
  /** How many live trades (counted from liveEnabledAt) get an extra
   *  liveProbationSizeMultiplier size cut on top of the risk profile's normal
   *  sizing and any loss-streak step-down already active (Phase 8 Step B). */
  liveProbationTrades: number;
  liveProbationSizeMultiplier: number;

  // --- Task #70: live options trading -----------------------------------

  /** Options-specific opt-in nested UNDER liveTradingEnabled — the master
   *  gate (and its typed confirmation phrase) already covers "real money is
   *  now live"; this is a plain checkbox with no second confirmation, same
   *  relationship optionsStrategyType already has to the paper loop's own
   *  master `enabled` toggle. The loop only places live OPTIONS orders when
   *  BOTH this and liveTradingEnabled are true. Reuses liveAccountId (already
   *  asset-agnostic — Webull returns one account for both stock and option
   *  orders) rather than a second account id field. */
  liveOptionsEnabled: boolean;
  /** Epoch ms of the most recent false -> true transition of
   *  liveOptionsEnabled, or null if never enabled. Anchors the OPTIONS
   *  probation window separately from liveEnabledAt: a user could enable live
   *  EQUITY trading first and only turn on live OPTIONS weeks later, so the
   *  options probation window should start when OPTIONS specifically went
   *  live, not when the master flag did. */
  liveOptionsEnabledAt: number | null;
  /** Guardrail caps for autotrade's own LIVE OPTIONS orders — dedicated,
   *  separate from the live EQUITY caps above (liveMaxOrderUsd etc.), mirroring
   *  how paper trading already keeps the two books' risk separate-but-combined.
   *  Options position sizing (premium-based, defined-risk by strike
   *  construction) is a different shape than equity's share-count sizing, so
   *  tuning these independently is deliberate, not an oversight. */
  liveOptionsMaxOrderUsd: number;
  liveOptionsMaxDailyLossUsd: number;
  liveOptionsMaxOrdersPerDay: number;
  liveOptionsFatFingerPct: number;
  /** Mirrors liveProbationTrades/liveProbationSizeMultiplier, counted from
   *  liveOptionsEnabledAt via countLiveOptionsOrdersSince() — a fully
   *  separate probation window from equity's own. */
  liveOptionsProbationTrades: number;
  liveOptionsProbationSizeMultiplier: number;

  // --- Options strategy shape (docs/AUTOTRADING_SPEC.md — phase 9/10 follow-up) ---

  /** 'single_leg' (default) or 'debit_spread' — see OptionsStrategyType doc
   *  comment above. Applies to both the paper-trading loop (loop.ts) and the
   *  /decide preview route (routes/autotrade.ts); backtesting is unaffected
   *  (options backtests remain single-leg only). */
  optionsStrategyType: OptionsStrategyType;

  // --- Movers auto-promotion (docs/AUTOTRADING_SPEC.md — the 2026-07-10
  // universe-widening fix's explicitly separate follow-up) ---------------

  /** Master on/off for promoting a recurring movers-sourced symbol into the
   *  persistent universe. Only ever runs from the automatic loop tick
   *  (services/autotrading/moversPromotion.ts, wired into loop.ts) — never
   *  from the manual "Run screen" route, since this addresses the AUTOMATED
   *  loop's own tendency to re-discover, then discard, the same genuinely
   *  active name every day. Defaults true: promotion can't fire until a
   *  symbol has accumulated autoPromoteThreshold days of history, so turning
   *  this on at deploy time carries no risk of an immediate mass-promotion. */
  autoPromoteMoversEnabled: boolean;
  /** A symbol needs this many DISTINCT calendar days as a movers-sourced,
   *  filters-passing screen candidate within autoPromoteWindowDays before
   *  it's promoted. */
  autoPromoteThreshold: number;
  /** Rolling calendar-day window autoPromoteThreshold is measured over. */
  autoPromoteWindowDays: number;
  /** Lifetime cap on symbols ADDED BY THIS MECHANISM specifically — doesn't
   *  count the seeded/user-added universe. Once a symbol is promoted (or a
   *  user removes a promoted symbol later), it's never reconsidered again
   *  either way: this is a one-shot "earn a permanent spot," not a rolling
   *  membership that could thrash. */
  autoPromoteMaxSymbols: number;
}

interface ConfigRow {
  config: string;
}

/** The exact phrase required to flip liveTradingEnabled false -> true (see
 *  routes/autotrade.ts) — a deliberate, one-time gesture per enable, not a
 *  per-order check. Case/whitespace-insensitive at the route, same
 *  normalization style as services/trading/placeOrder.ts's placeConfirmation. */
export const LIVE_TRADING_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';

/** Independent of maxTradesPerDay below (a live-only broker guardrail, not
 *  the risk-check's own trade-count cap) — the two happen to share a default,
 *  not a dependency. */
const DEFAULT_LIVE_MAX_ORDERS_PER_DAY = 6;

export function defaultAutotradeConfig(): AutotradeConfig {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    accountEquityUsd: null,
    maxConcurrentPositions: 2,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    stepDownAfterLosses: 2,
    stepDownSizeCutPct: 50,
    maxAggregateOpenRiskPct: 2,
    maxCorrelatedExposurePct: 6,
    maxTradesPerDay: 6,
    minRelVol: 1.5,
    maxTickerAtrPct: 15,
    maxMarketAtrPct: 5,
    stopAtrMultiple: 1.5,
    targetRMultiple: 2,
    sessionBufferMinutes: 15,
    liveTradingEnabled: false,
    liveEnabledAt: null,
    liveAccountId: null,
    liveMaxOrderUsd: 500,
    liveMaxDailyLossUsd: 250,
    liveMaxOrdersPerDay: DEFAULT_LIVE_MAX_ORDERS_PER_DAY,
    liveFatFingerPct: 10,
    liveAllowNakedShort: false,
    liveProbationTrades: 20,
    liveProbationSizeMultiplier: 0.5,
    liveOptionsEnabled: false,
    liveOptionsEnabledAt: null,
    liveOptionsMaxOrderUsd: 500,
    liveOptionsMaxDailyLossUsd: 250,
    liveOptionsMaxOrdersPerDay: DEFAULT_LIVE_MAX_ORDERS_PER_DAY,
    liveOptionsFatFingerPct: 10,
    liveOptionsProbationTrades: 20,
    liveOptionsProbationSizeMultiplier: 0.5,
    optionsStrategyType: 'single_leg',
    autoPromoteMoversEnabled: true,
    autoPromoteThreshold: 3,
    autoPromoteWindowDays: 10,
    autoPromoteMaxSymbols: 50,
  };
}

/** Coerce a stored/patched config into a safe, complete AutotradeConfig. */
function sanitize(input: Partial<AutotradeConfig>): AutotradeConfig {
  const d = defaultAutotradeConfig();
  const equity =
    input.accountEquityUsd === null
      ? null
      : typeof input.accountEquityUsd === 'number' && input.accountEquityUsd > 0
        ? input.accountEquityUsd
        : d.accountEquityUsd;
  const nonNeg = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const pct = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  };
  const posInt = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  // At least 1 — unlike posInt, 0 isn't a valid "unlimited" or "off" reading
  // here; it would silently block every entry forever without the clarity of
  // the kill switch, which already exists for that.
  const posIntMin1 = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  // A positive (non-zero), fraction-preserving number — like posIntMin1 but
  // keeps decimal precision (ATR/R multiples are routinely fractional, e.g.
  // 1.5× ATR), and unlike nonNeg/pct, 0 is never valid here: a zero stop
  // distance or zero-R target is meaningless, and this app requires a real
  // stop on every position.
  const posDecimal = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const accountId =
    input.liveAccountId === null
      ? null
      : typeof input.liveAccountId === 'string' && input.liveAccountId.trim() !== ''
        ? input.liveAccountId.trim()
        : d.liveAccountId;
  const enabledAt =
    typeof input.liveEnabledAt === 'number' && Number.isFinite(input.liveEnabledAt) ? input.liveEnabledAt : null;
  const optionsEnabledAt =
    typeof input.liveOptionsEnabledAt === 'number' && Number.isFinite(input.liveOptionsEnabledAt)
      ? input.liveOptionsEnabledAt
      : null;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d.enabled,
    killSwitch: typeof input.killSwitch === 'boolean' ? input.killSwitch : d.killSwitch,
    riskProfile:
      input.riskProfile === 'AGGRESSIVE' || input.riskProfile === 'MODERATE' ? input.riskProfile : d.riskProfile,
    accountEquityUsd: equity,
    maxConcurrentPositions: posIntMin1(input.maxConcurrentPositions, d.maxConcurrentPositions),
    riskPerTradePct: pct(input.riskPerTradePct, d.riskPerTradePct),
    maxDailyDrawdownPct: pct(input.maxDailyDrawdownPct, d.maxDailyDrawdownPct),
    stepDownAfterLosses: posInt(input.stepDownAfterLosses, d.stepDownAfterLosses),
    stepDownSizeCutPct: pct(input.stepDownSizeCutPct, d.stepDownSizeCutPct),
    maxAggregateOpenRiskPct: pct(input.maxAggregateOpenRiskPct, d.maxAggregateOpenRiskPct),
    maxCorrelatedExposurePct: pct(input.maxCorrelatedExposurePct, d.maxCorrelatedExposurePct),
    maxTradesPerDay: posInt(input.maxTradesPerDay, d.maxTradesPerDay),
    minRelVol: nonNeg(input.minRelVol, d.minRelVol),
    maxTickerAtrPct: pct(input.maxTickerAtrPct, d.maxTickerAtrPct),
    maxMarketAtrPct: pct(input.maxMarketAtrPct, d.maxMarketAtrPct),
    stopAtrMultiple: posDecimal(input.stopAtrMultiple, d.stopAtrMultiple),
    targetRMultiple: posDecimal(input.targetRMultiple, d.targetRMultiple),
    sessionBufferMinutes: posInt(input.sessionBufferMinutes, d.sessionBufferMinutes),
    liveTradingEnabled: typeof input.liveTradingEnabled === 'boolean' ? input.liveTradingEnabled : d.liveTradingEnabled,
    liveEnabledAt: enabledAt,
    liveAccountId: accountId,
    liveMaxOrderUsd: nonNeg(input.liveMaxOrderUsd, d.liveMaxOrderUsd),
    liveMaxDailyLossUsd: nonNeg(input.liveMaxDailyLossUsd, d.liveMaxDailyLossUsd),
    liveMaxOrdersPerDay: posInt(input.liveMaxOrdersPerDay, d.liveMaxOrdersPerDay),
    liveFatFingerPct: pct(input.liveFatFingerPct, d.liveFatFingerPct),
    liveAllowNakedShort:
      typeof input.liveAllowNakedShort === 'boolean' ? input.liveAllowNakedShort : d.liveAllowNakedShort,
    liveProbationTrades: posInt(input.liveProbationTrades, d.liveProbationTrades),
    liveProbationSizeMultiplier: (() => {
      const n = Number(input.liveProbationSizeMultiplier);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : d.liveProbationSizeMultiplier;
    })(),
    liveOptionsEnabled: typeof input.liveOptionsEnabled === 'boolean' ? input.liveOptionsEnabled : d.liveOptionsEnabled,
    liveOptionsEnabledAt: optionsEnabledAt,
    liveOptionsMaxOrderUsd: nonNeg(input.liveOptionsMaxOrderUsd, d.liveOptionsMaxOrderUsd),
    liveOptionsMaxDailyLossUsd: nonNeg(input.liveOptionsMaxDailyLossUsd, d.liveOptionsMaxDailyLossUsd),
    liveOptionsMaxOrdersPerDay: posInt(input.liveOptionsMaxOrdersPerDay, d.liveOptionsMaxOrdersPerDay),
    liveOptionsFatFingerPct: pct(input.liveOptionsFatFingerPct, d.liveOptionsFatFingerPct),
    liveOptionsProbationTrades: posInt(input.liveOptionsProbationTrades, d.liveOptionsProbationTrades),
    liveOptionsProbationSizeMultiplier: (() => {
      const n = Number(input.liveOptionsProbationSizeMultiplier);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : d.liveOptionsProbationSizeMultiplier;
    })(),
    optionsStrategyType:
      input.optionsStrategyType === 'debit_spread' || input.optionsStrategyType === 'single_leg'
        ? input.optionsStrategyType
        : d.optionsStrategyType,
    autoPromoteMoversEnabled:
      typeof input.autoPromoteMoversEnabled === 'boolean' ? input.autoPromoteMoversEnabled : d.autoPromoteMoversEnabled,
    autoPromoteThreshold: posIntMin1(input.autoPromoteThreshold, d.autoPromoteThreshold),
    autoPromoteWindowDays: posIntMin1(input.autoPromoteWindowDays, d.autoPromoteWindowDays),
    autoPromoteMaxSymbols: posInt(input.autoPromoteMaxSymbols, d.autoPromoteMaxSymbols),
  };
}

/** The current persisted auto-trading config, or defaults (off, MODERATE) if unset/corrupt. */
export function getAutotradeConfig(): AutotradeConfig {
  const row = db.prepare('SELECT config FROM autotrade_config WHERE id = 1').get() as ConfigRow | undefined;
  if (!row) return defaultAutotradeConfig();
  try {
    return sanitize(JSON.parse(row.config) as Partial<AutotradeConfig>);
  } catch {
    return defaultAutotradeConfig();
  }
}

/** Merge a partial patch over the current config and persist it (singleton upsert). */
export function setAutotradeConfig(patch: Partial<AutotradeConfig>): AutotradeConfig {
  const next = sanitize({ ...getAutotradeConfig(), ...patch });
  db.prepare(
    `INSERT INTO autotrade_config (id, config, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(next), Date.now());
  return next;
}

/** Engage or release the auto-trading kill switch (sticky halt). Convenience
 *  over setAutotradeConfig — mirrors db/trading.ts's setKillSwitch. */
export function setAutotradeKillSwitch(on: boolean): AutotradeConfig {
  return setAutotradeConfig({ killSwitch: on });
}
