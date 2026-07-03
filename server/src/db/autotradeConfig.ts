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
   *  tuned around. See suggestLiveCaps() for the equity/profile-derived
   *  starting formula; freely editable afterward. */
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

  // --- Options strategy shape (docs/AUTOTRADING_SPEC.md — phase 9/10 follow-up) ---

  /** 'single_leg' (default) or 'debit_spread' — see OptionsStrategyType doc
   *  comment above. Applies to both the paper-trading loop (loop.ts) and the
   *  /decide preview route (routes/autotrade.ts); backtesting is unaffected
   *  (options backtests remain single-leg only). */
  optionsStrategyType: OptionsStrategyType;
}

interface ConfigRow {
  config: string;
}

/** The exact phrase required to flip liveTradingEnabled false -> true (see
 *  routes/autotrade.ts) — a deliberate, one-time gesture per enable, not a
 *  per-order check. Case/whitespace-insensitive at the route, same
 *  normalization style as services/trading/placeOrder.ts's placeConfirmation. */
export const LIVE_TRADING_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';

/** MODERATE's own maxTradesPerDay (services/autotrading/riskProfiles.ts) — kept
 *  as a literal here rather than imported, since riskProfiles.ts already
 *  imports RiskProfileName from this file and importing the value back would
 *  create a circular module dependency. */
const DEFAULT_LIVE_MAX_ORDERS_PER_DAY = 6;

export function defaultAutotradeConfig(): AutotradeConfig {
  return {
    enabled: false,
    killSwitch: false,
    riskProfile: 'MODERATE',
    accountEquityUsd: null,
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
    optionsStrategyType: 'single_leg',
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
  const accountId =
    input.liveAccountId === null
      ? null
      : typeof input.liveAccountId === 'string' && input.liveAccountId.trim() !== ''
        ? input.liveAccountId.trim()
        : d.liveAccountId;
  const enabledAt =
    typeof input.liveEnabledAt === 'number' && Number.isFinite(input.liveEnabledAt) ? input.liveEnabledAt : null;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d.enabled,
    killSwitch: typeof input.killSwitch === 'boolean' ? input.killSwitch : d.killSwitch,
    riskProfile:
      input.riskProfile === 'AGGRESSIVE' || input.riskProfile === 'MODERATE' ? input.riskProfile : d.riskProfile,
    accountEquityUsd: equity,
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
    optionsStrategyType:
      input.optionsStrategyType === 'debit_spread' || input.optionsStrategyType === 'single_leg'
        ? input.optionsStrategyType
        : d.optionsStrategyType,
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
