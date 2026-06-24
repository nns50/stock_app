import { db } from './index';
import { defaultTradingConfig, TradingConfig } from '../services/trading/guardrails';

// ---------------------------------------------------------------------------
// Persistence for the live-trading config — the runtime caps + the KILL SWITCH
// (see docs/LIVE_TRADING_DESIGN.md §7). Stored as one JSON row so adding a cap
// later needs no migration; reads merge over defaultTradingConfig() so the
// returned config is always complete and forward-compatible.
//
// This is the durable home of the kill switch and the guardrail caps. It does
// NOT place orders or talk to a broker — it only stores the settings the (pure)
// guardrail engine reads. The master `enabled` flag persists here too, but when
// the order pipeline is built it will be AND-ed with the TRADING_ENABLED env
// gate, so a fresh deploy can never trade on stored state alone.
// ---------------------------------------------------------------------------

interface ConfigRow {
  config: string;
}

/** Coerce a stored/patched config into a safe, complete TradingConfig. */
function sanitize(input: Partial<TradingConfig>): TradingConfig {
  const d = defaultTradingConfig();
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const nonNeg = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const pct = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  };
  return {
    enabled: bool(input.enabled, d.enabled),
    killSwitch: bool(input.killSwitch, d.killSwitch),
    maxOrderUsd: nonNeg(input.maxOrderUsd, d.maxOrderUsd),
    maxSymbolPositionQty: nonNeg(input.maxSymbolPositionQty, d.maxSymbolPositionQty),
    maxExposureUsd: nonNeg(input.maxExposureUsd, d.maxExposureUsd),
    maxOrdersPerDay: nonNeg(input.maxOrdersPerDay, d.maxOrdersPerDay),
    maxDailyLossUsd: nonNeg(input.maxDailyLossUsd, d.maxDailyLossUsd),
    fatFingerPct: pct(input.fatFingerPct, d.fatFingerPct),
    allowNakedShort: bool(input.allowNakedShort, d.allowNakedShort),
  };
}

/** The current persisted trading config, or conservative defaults if unset/corrupt. */
export function getTradingConfig(): TradingConfig {
  const row = db.prepare('SELECT config FROM trading_config WHERE id = 1').get() as ConfigRow | undefined;
  if (!row) return defaultTradingConfig();
  try {
    return sanitize(JSON.parse(row.config) as Partial<TradingConfig>);
  } catch {
    return defaultTradingConfig();
  }
}

/** Merge a partial patch over the current config and persist it (singleton upsert). */
export function setTradingConfig(patch: Partial<TradingConfig>): TradingConfig {
  const next = sanitize({ ...getTradingConfig(), ...patch });
  db.prepare(
    `INSERT INTO trading_config (id, config, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(next), Date.now());
  return next;
}

/** Engage or release the kill switch (sticky halt). Convenience over setTradingConfig. */
export function setKillSwitch(on: boolean): TradingConfig {
  return setTradingConfig({ killSwitch: on });
}
