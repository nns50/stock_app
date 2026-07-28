import { getSetting, setSetting } from '../db/settings';
import { logAutotradeEvent } from '../db/autotradeEvents';
import { runWebullPositionsSync, WebullSyncResult } from '../providers/webull/positions';
import { reconcileAllWorking } from './trading/reconcile';

// ---------------------------------------------------------------------------
// Background Webull sync. A single self-scheduling loop keeps the journal in
// sync with the broker on two fronts — independent of any open browser tab,
// so nobody has to remember to click a button:
//   1. Order reconcile (reconcileAllWorking): picks up fills on orders THIS
//      app already placed and knows about — including a bracket's stop-loss/
//      take-profit exit leg (see services/trading/reconcile.ts's
//      watchingBracketExit), which "Refresh all" alone never used to detect
//      once the entry itself had gone terminal.
//   2. Position-truth sync (runWebullPositionsSync): catches anything the
//      order reconcile still can't attribute to a known order — e.g. sold
//      directly in the Webull app — by diffing against Webull's live
//      holdings, plus imports new positions.
// Enabled by default, but a no-op until an account id is configured (same
// fail-quiet posture as the alert scheduler while unconfigured); the
// interval/enabled/account id all live in a setting (UI-toggleable on
// Settings), so the loop re-reads them each cycle and adjusts without a
// restart.
// ---------------------------------------------------------------------------

export interface WebullSyncConfig {
  enabled: boolean;
  intervalSeconds: number;
  /** Every Webull account the background sync should reconcile each tick. A
   *  user with more than one real account (e.g. a cash account AND a margin
   *  account) needs all of them here — the old single-account form only ever
   *  reconciled one, leaving the other account's sold positions stuck open
   *  forever. Empty = a no-op (nothing to sync), same fail-quiet posture as
   *  before an account was configured. */
  accountIds: string[];
}

/** The persisted shape may still carry the pre-2026-07-23 single `accountId`
 *  field; getWebullSyncConfig migrates it into accountIds on read. */
type StoredWebullSyncConfig = Partial<WebullSyncConfig> & { accountId?: string | null };

const SETTING_KEY = 'webullPositionsScheduler';
const DEFAULT: WebullSyncConfig = { enabled: true, intervalSeconds: 300, accountIds: [] };

function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((a) => String(a).trim()).filter(Boolean))];
}
/** Floor on the interval — this writes journal data and hits the live
 *  positions endpoint, so a slightly higher floor than the read-only alert
 *  scheduler's. */
export const MIN_SYNC_INTERVAL_SECONDS = 60;
/** How often to re-check the setting while disabled/unconfigured. */
const IDLE_POLL_SECONDS = 30;

export function getWebullSyncConfig(): WebullSyncConfig {
  const s = (getSetting<StoredWebullSyncConfig>(SETTING_KEY) ?? {}) as StoredWebullSyncConfig;
  const raw = Number(s.intervalSeconds);
  // Prefer the new list; fall back to a legacy single accountId so an existing
  // one-account config keeps working (and gets rewritten as a list on the next save).
  const accountIds =
    s.accountIds !== undefined
      ? normalizeIds(s.accountIds)
      : typeof s.accountId === 'string' && s.accountId.trim() !== ''
        ? [s.accountId.trim()]
        : [];
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT.enabled,
    intervalSeconds: Math.max(MIN_SYNC_INTERVAL_SECONDS, Number.isFinite(raw) ? raw : DEFAULT.intervalSeconds),
    accountIds,
  };
}

export function setWebullSyncConfig(patch: StoredWebullSyncConfig): WebullSyncConfig {
  const current = getWebullSyncConfig();
  // accountIds (new, canonical) wins; a legacy single accountId patch is still
  // accepted and REPLACES the list with that one id (or clears it), so any old
  // caller keeps working.
  let accountIds = current.accountIds;
  if (patch.accountIds !== undefined) {
    accountIds = normalizeIds(patch.accountIds);
  } else if (patch.accountId !== undefined) {
    const id = patch.accountId?.trim();
    accountIds = id ? [id] : [];
  }
  const next: WebullSyncConfig = {
    enabled: patch.enabled ?? current.enabled,
    intervalSeconds: Math.max(MIN_SYNC_INTERVAL_SECONDS, patch.intervalSeconds ?? current.intervalSeconds),
    accountIds,
  };
  setSetting(SETTING_KEY, next);
  return next;
}

export interface WebullFullSyncResult extends WebullSyncResult {
  /** Still-working orders checked against the broker (reconcileAllWorking). */
  ordersReconciled: number;
  /** How many of those advanced to a new state (a fill, a bracket exit leg, etc). */
  ordersChanged: number;
}

/**
 * Reconcile every still-working order THIS app placed, THEN run the
 * position-truth sync (close/import) to catch anything that still isn't
 * reflected. Both the manual "Sync now" action and the background scheduler
 * call this — one place for "make the journal match Webull."
 */
export async function syncWebullAccount(accountId: string): Promise<WebullFullSyncResult> {
  const orderResult = await reconcileAllWorking(accountId);
  const posResult = await runWebullPositionsSync(accountId);
  return { ...posResult, ordersReconciled: orderResult.reconciled, ordersChanged: orderResult.changed };
}

/** Last outcome per account: undefined = never observed, null = last run
 *  succeeded, a string = last run's failure message. In-memory on purpose —
 *  it only gates the failure/recovery TRANSITION events below, and after a
 *  restart re-reporting one transition is harmless. */
const lastSyncError = new Map<string, string | null>();

/** Tests only: forget prior outcomes so transition events fire predictably. */
export function resetWebullSyncFailureTracking(): void {
  lastSyncError.clear();
}

/** Log the failure/recovery TRANSITIONS of the background sync to the Recent
 *  Activity feed. A background sync that quietly stops working (an expired
 *  token, a changed payload shape) is indistinguishable from "nothing to sync"
 *  from the Positions page — the journal just drifts stale against the broker,
 *  with the only trace on the server console nobody reads. Transition-only so
 *  a persistent failure is one event, not one per tick. */
function noteSyncOutcome(accountId: string, error: string | null): void {
  const prev = lastSyncError.get(accountId);
  lastSyncError.set(accountId, error);
  if (error && !prev) {
    logAutotradeEvent({
      stage: 'execution',
      action: 'webull_sync_failed',
      detail: {
        via: 'broker_sync_scheduler',
        accountId,
        error,
        note:
          'The background Webull position sync is failing — no closes or imports happen until it recovers, so ' +
          'the journal will drift from the broker. Check Settings → Webull.',
      },
    });
  } else if (!error && prev) {
    logAutotradeEvent({
      stage: 'execution',
      action: 'webull_sync_recovered',
      detail: { via: 'broker_sync_scheduler', accountId, note: 'Background Webull position sync is working again.' },
    });
  }
}

/** One sync pass over EVERY configured account — exposed for tests/manual
 *  triggering. Returns null (a no-op, not an error) while disabled or before
 *  any account id is set; otherwise one result per account. Accounts sync
 *  sequentially (each hits the live-positions endpoint + writes), and one
 *  account's failure is isolated so the rest still run — a single bad broker
 *  response for the cash account can't stop the margin account from
 *  reconciling. */
export async function runSchedulerTick(): Promise<WebullFullSyncResult[] | null> {
  const cfg = getWebullSyncConfig();
  if (!cfg.enabled || cfg.accountIds.length === 0) return null;
  const results: WebullFullSyncResult[] = [];
  for (const accountId of cfg.accountIds) {
    try {
      const r = await syncWebullAccount(accountId);
      results.push(r);
      noteSyncOutcome(accountId, r.ok ? null : r.error || 'sync failed');
    } catch (e) {
      console.error(`[webull-positions-scheduler] account ${accountId} sync failed:`, (e as Error).message);
      noteSyncOutcome(accountId, (e as Error).message || 'sync failed');
    }
  }
  return results;
}

let timer: NodeJS.Timeout | null = null;
let started = false;

async function loop(): Promise<void> {
  // NOTHING in this body may escape the try: loop() is invoked fire-and-forget
  // from a timer, so a rejection here is an unhandled rejection — which kills
  // the whole PROCESS on modern Node, not just this poller. That includes the
  // config read (a DB access that can throw on a wedged disk), which used to
  // sit outside the guard: one transient DB error crashed the server and, even
  // if it hadn't, the loop would never have re-armed.
  let delaySec = IDLE_POLL_SECONDS;
  try {
    const cfg = getWebullSyncConfig();
    const active = cfg.enabled && cfg.accountIds.length > 0;
    // Cadence decided before the tick runs, so a failed tick still re-polls on
    // the configured interval instead of the idle fallback.
    delaySec = active ? cfg.intervalSeconds : IDLE_POLL_SECONDS;
    if (active) await runSchedulerTick();
  } catch (e) {
    console.error('[webull-positions-scheduler]', e instanceof Error ? e.message : e);
  }
  // stopWebullPositionsSync() during an in-flight sync used to be undone right
  // here: clearTimeout only cancels the PENDING timer, and this line then
  // scheduled a fresh one. Shutdown/tests rely on stop meaning stopped.
  if (!started) return;
  timer = setTimeout(() => void loop(), delaySec * 1000);
  timer.unref?.(); // don't keep the process alive on the timer alone
}

/** Start the poll loop (idempotent). Call once after the server starts. */
export function startWebullPositionsSync(): void {
  if (started) return;
  started = true;
  timer = setTimeout(() => void loop(), 1000);
  timer.unref?.();
}

/** Stop the loop (tests / shutdown). */
export function stopWebullPositionsSync(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}
