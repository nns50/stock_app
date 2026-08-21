import { db } from './index';

// ---------------------------------------------------------------------------
// The account's equity at the start of the current ET day — the base the
// daily-gain target is a percentage OF (services/autotrading/dailyTarget.ts).
// Singleton, overwritten on the first tick of each new ET day: yesterday's
// baseline has no further use once its day is over (the journal's
// daily_target_reached events are the history), and persisting it here rather
// than in memory means a mid-day server restart neither loses today's base nor
// re-baselines at whatever equity the restart happened to see.
// ---------------------------------------------------------------------------

export interface DailyBaseline {
  /** YYYY-MM-DD in America/New_York — the day this baseline belongs to. */
  etDate: string;
  /** Synced equity at the day's first tick (≈ the prior session's close). */
  equityUsd: number;
  /** Epoch ms the daily target was FIRST reached today, or null. Sticky for
   *  the rest of the day once set — see dailyTarget.ts for why. */
  reachedAt: number | null;
}

interface Row {
  et_date: string;
  equity_usd: number;
  reached_at: number | null;
}

export function getDailyBaseline(): DailyBaseline | null {
  const row = db.prepare('SELECT et_date, equity_usd, reached_at FROM autotrade_daily_baseline WHERE id = 1').get() as
    Row | undefined;
  if (!row) return null;
  return { etDate: row.et_date, equityUsd: row.equity_usd, reachedAt: row.reached_at };
}

/** Start a fresh day: overwrite the singleton with today's base equity and a
 *  cleared reached flag. */
export function saveDailyBaseline(etDate: string, equityUsd: number): DailyBaseline {
  db.prepare(
    `INSERT INTO autotrade_daily_baseline (id, et_date, equity_usd, reached_at) VALUES (1, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET et_date = excluded.et_date, equity_usd = excluded.equity_usd, reached_at = NULL`,
  ).run(etDate, equityUsd);
  return { etDate, equityUsd, reachedAt: null };
}

/** Mark today's target reached (first time only — the caller checks). */
export function markDailyTargetReached(reachedAt: number): void {
  db.prepare('UPDATE autotrade_daily_baseline SET reached_at = ? WHERE id = 1 AND reached_at IS NULL').run(reachedAt);
}
