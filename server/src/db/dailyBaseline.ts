import { db } from './index';

// ---------------------------------------------------------------------------
// The account's equity at the start of the current ET day — the base the
// daily-gain target is a percentage OF (services/autotrading/dailyTarget.ts).
// Singleton, overwritten on the first tick of each new ET day: yesterday's
// baseline has no further use once its day is over (the journal's
// daily_target_reached events are the history), and persisting it here rather
// than in memory means a mid-day server restart neither loses today's base nor
// re-baselines at whatever equity the restart happened to see.
//
// Also carries the give-back guard's two sticky timestamps (armed/fired) for
// the same reason the reach flag lives here: a restart mid-day must not
// forget that the guard armed at +2% and re-open entries into a fade.
// ---------------------------------------------------------------------------

export interface DailyBaseline {
  /** YYYY-MM-DD in America/New_York — the day this baseline belongs to. */
  etDate: string;
  /** Synced equity at the day's first tick (≈ the prior session's close). */
  equityUsd: number;
  /** Epoch ms the daily target was FIRST reached today, or null. Sticky for
   *  the rest of the day once set — see dailyTarget.ts for why. */
  reachedAt: number | null;
  /** Epoch ms the give-back guard ARMED today (day gain first touched the arm
   *  level), or null. Sticky: a faded gain doesn't disarm. */
  giveBackArmedAt: number | null;
  /** Epoch ms the give-back guard FIRED today (an armed day fell back to the
   *  floor — live entries halted), or null. Sticky like reachedAt. */
  giveBackHaltedAt: number | null;
}

interface Row {
  et_date: string;
  equity_usd: number;
  reached_at: number | null;
  give_back_armed_at: number | null;
  give_back_halted_at: number | null;
}

export function getDailyBaseline(): DailyBaseline | null {
  const row = db
    .prepare(
      `SELECT et_date, equity_usd, reached_at, give_back_armed_at, give_back_halted_at
       FROM autotrade_daily_baseline WHERE id = 1`,
    )
    .get() as Row | undefined;
  if (!row) return null;
  return {
    etDate: row.et_date,
    equityUsd: row.equity_usd,
    reachedAt: row.reached_at,
    giveBackArmedAt: row.give_back_armed_at,
    giveBackHaltedAt: row.give_back_halted_at,
  };
}

/** Start a fresh day: overwrite the singleton with today's base equity and
 *  clear the reach flag AND both give-back timestamps — every sticky halt is
 *  a per-day fact. */
export function saveDailyBaseline(etDate: string, equityUsd: number): DailyBaseline {
  db.prepare(
    `INSERT INTO autotrade_daily_baseline (id, et_date, equity_usd, reached_at, give_back_armed_at, give_back_halted_at)
     VALUES (1, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET et_date = excluded.et_date, equity_usd = excluded.equity_usd,
       reached_at = NULL, give_back_armed_at = NULL, give_back_halted_at = NULL`,
  ).run(etDate, equityUsd);
  return { etDate, equityUsd, reachedAt: null, giveBackArmedAt: null, giveBackHaltedAt: null };
}

/** Mark today's target reached (first time only — the caller checks). */
export function markDailyTargetReached(reachedAt: number): void {
  db.prepare('UPDATE autotrade_daily_baseline SET reached_at = ? WHERE id = 1 AND reached_at IS NULL').run(reachedAt);
}

/** Mark the give-back guard armed for today (first time only). */
export function markGiveBackArmed(armedAt: number): void {
  db.prepare(
    'UPDATE autotrade_daily_baseline SET give_back_armed_at = ? WHERE id = 1 AND give_back_armed_at IS NULL',
  ).run(armedAt);
}

/** Mark the give-back guard fired for today (first time only). */
export function markGiveBackHalted(haltedAt: number): void {
  db.prepare(
    'UPDATE autotrade_daily_baseline SET give_back_halted_at = ? WHERE id = 1 AND give_back_halted_at IS NULL',
  ).run(haltedAt);
}
