import { db } from './index';

/** How many consecutive syncs a contract must be absent from the broker's
 *  live preview, with no confirmed-held observation in between, before the
 *  caller should treat it as actually closed — see the webull_miss_streak
 *  table comment (db/index.ts) for why this exists. */
export const MISS_CONFIRM_THRESHOLD = 2;

/** Record one more consecutive "not found in this preview" observation for
 *  (accountId, contractKey) and return the new streak. The first miss of a run
 *  also stamps when the run began (see missStreakStartedAt). `brokerQty` is
 *  what the broker still showed for it (0 when none at all); a caller that
 *  does not know leaves it null (missStreakBrokerQty). */
export function bumpMissStreak(accountId: string, contractKey: string, brokerQty: number | null = null): number {
  const now = Date.now();
  // In an ON CONFLICT update, a bare column name is the row's OLD value, so a
  // legacy row with no start recorded takes its previous bump as the start.
  db.prepare(
    `INSERT INTO webull_miss_streak (account_id, contract_key, streak, updated_at, first_missed_at, broker_qty)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(account_id, contract_key) DO UPDATE SET
       streak = streak + 1,
       first_missed_at = COALESCE(first_missed_at, updated_at),
       updated_at = excluded.updated_at,
       broker_qty = excluded.broker_qty`,
  ).run(accountId, contractKey, now, now, brokerQty);
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
/** The current run of consecutive syncs that did not find `contractKey` at
 *  the broker; 0 when it was last seen, or never missed. Read-only. */
export function missStreakOf(accountId: string, contractKey: string): number {
  const row = db
    .prepare('SELECT streak FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?')
    .get(accountId, contractKey) as { streak: number } | undefined;
  return row?.streak ?? 0;
}

/**
 * The shares the broker still showed on the latest miss (2026-09-25, #147), or
 * null when unknown: no current miss, or a bump that did not say. A miss is ANY
 * gap between the ledger and the broker; "the shares are gone" is only a gap
 * to 0, which is what a filled bracket leg leaves.
 */
export function missStreakBrokerQty(accountId: string, contractKey: string): number | null {
  const row = db
    .prepare('SELECT broker_qty AS brokerQty FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?')
    .get(accountId, contractKey) as { brokerQty: number | null } | undefined;
  return row?.brokerQty ?? null;
}

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

/**
 * End every run of misses in `accountId` that `owns` claims but the caller no
 * longer has an open lot for (2026-09-23). Returns how many were ended.
 *
 * A run is counted against open journal lots, and until now only two things
 * ended it: a sync that found the contract held, or that same sync closing the
 * lots itself. A position usually closes some other way. A bracket leg fills,
 * the sync defers to the entry order's reconcile, and that reconcile books the
 * fill. The key then has no lots, so no sync looks at it again, and its run
 * stays in the table with its count and start time.
 *
 * The next position on the same contract inherits that run. GRML's take-profit
 * filled on 2026-09-22 after the sync had counted it missing two or more times.
 * On 2026-09-23 a new GRML position had its stop fill at once, and the first
 * miss read the old count and the old start time. Both the two-sync debounce
 * and the four-minute bracket grace looked spent. The sync booked a 16.04 quote
 * one second after the fill, before the entry's reconcile could book the leg.
 *
 * `owns` limits the purge to the caller's own keys. Other code keeps runs in
 * the same table (the options sleeve uses `opt:<position id>`).
 */
export function clearMissStreaksWithoutLots(
  accountId: string,
  lotKeys: ReadonlySet<string>,
  owns: (contractKey: string) => boolean,
): number {
  const rows = db
    .prepare('SELECT contract_key AS contractKey FROM webull_miss_streak WHERE account_id = ?')
    .all(accountId) as { contractKey: string }[];
  const stale = rows.map((r) => r.contractKey).filter((k) => owns(k) && !lotKeys.has(k));
  const del = db.prepare('DELETE FROM webull_miss_streak WHERE account_id = ? AND contract_key = ?');
  for (const k of stale) del.run(accountId, k);
  return stale.length;
}
