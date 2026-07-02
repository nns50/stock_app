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

export interface AutotradeConfig {
  /** Master on/off for the auto-trading execution loop. */
  enabled: boolean;
  /** Active risk profile. Defaults to MODERATE; switching to AGGRESSIVE is
   *  gated by an explicit confirmation at the route (see routes/autotrade.ts). */
  riskProfile: RiskProfileName;
}

interface ConfigRow {
  config: string;
}

export function defaultAutotradeConfig(): AutotradeConfig {
  return { enabled: false, riskProfile: 'MODERATE' };
}

/** Coerce a stored/patched config into a safe, complete AutotradeConfig. */
function sanitize(input: Partial<AutotradeConfig>): AutotradeConfig {
  const d = defaultAutotradeConfig();
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d.enabled,
    riskProfile:
      input.riskProfile === 'AGGRESSIVE' || input.riskProfile === 'MODERATE' ? input.riskProfile : d.riskProfile,
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
