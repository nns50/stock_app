import { db } from './index';

/** How many consecutive syncs a contract must be absent from the broker's
 *  live preview, with no confirmed-held observation in between, before the
 *  caller should treat it as actually closed — see the webull_miss_streak
 *  table comment (db/index.ts) for why this exists. */
export const MISS_CONFIRM_THRESHOLD = 2;

/** Record one more consecutive "not found in this preview" observation for
 *  (accountId, contractKey) and return the new streak. */
export function bumpMissStreak(accountId: string, contractKey: string): number {
  db.prepare(
    `INSERT INTO webull_miss_streak (account_id, contract_key, streak, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(account_id, contract_key) DO UPDATE SET streak = streak + 1, updated_at = excluded.updated_at`,
  ).run(accountId, contractKey, Date.now());
  const row = db
    .prepare('SELECT streak FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?')
    .get(accountId, contractKey) as { streak: number } | undefined;
  return row?.streak ?? 0;
}

/** A sync confirmed this contract IS still held — forget any prior misses. */
export function clearMissStreak(accountId: string, contractKey: string): void {
  db.prepare('DELETE FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?').run(accountId, contractKey);
}
