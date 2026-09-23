import { db } from './index';

/** How many consecutive syncs a contract must be absent from the broker's
 *  live preview, with no confirmed-held observation in between, before the
 *  caller should treat it as actually closed — see the webull_miss_streak
 *  table comment (db/index.ts) for why this exists. */
export const MISS_CONFIRM_THRESHOLD = 2;

/** Record one more consecutive "not found in this preview" observation for
 *  (accountId, contractKey) and return the new streak. The first miss of a run
 *  also stamps when the run began (see missStreakStartedAt). */
export function bumpMissStreak(accountId: string, contractKey: string): number {
  const now = Date.now();
  // In an ON CONFLICT update, a bare column name is the row's OLD value, so a
  // legacy row with no start recorded takes its previous bump as the start.
  db.prepare(
    `INSERT INTO webull_miss_streak (account_id, contract_key, streak, updated_at, first_missed_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(account_id, contract_key) DO UPDATE SET
       streak = streak + 1,
       first_missed_at = COALESCE(first_missed_at, updated_at),
       updated_at = excluded.updated_at`,
  ).run(accountId, contractKey, now, now);
  const row = db
    .prepare('SELECT streak FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?')
    .get(accountId, contractKey) as { streak: number } | undefined;
  return row?.streak ?? 0;
}

/**
 * When the current run of misses for (accountId, contractKey) began, or null
 * when the contract is not missing. A COUNT of misses is not a duration: the
 * loop's sync and the background scheduler both bump the same row, so in
 * production a streak of 4 has been as little as two minutes (COIN, 2026-09-21).
 */
export function missStreakStartedAt(accountId: string, contractKey: string): number | null {
  const row = db
    .prepare(
      'SELECT COALESCE(first_missed_at, updated_at) AS startedAt FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?',
    )
    .get(accountId, contractKey) as { startedAt: number } | undefined;
  return row?.startedAt ?? null;
}

/** A sync confirmed this contract IS still held — forget any prior misses. */
export function clearMissStreak(accountId: string, contractKey: string): void {
  db.prepare('DELETE FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?').run(accountId, contractKey);
}
