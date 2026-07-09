import { getSetting, setSetting } from '../db/settings';
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
  accountId: string | null;
}

const SETTING_KEY = 'webullPositionsScheduler';
const DEFAULT: WebullSyncConfig = { enabled: true, intervalSeconds: 300, accountId: null };
/** Floor on the interval — this writes journal data and hits the live
 *  positions endpoint, so a slightly higher floor than the read-only alert
 *  scheduler's. */
export const MIN_SYNC_INTERVAL_SECONDS = 60;
/** How often to re-check the setting while disabled/unconfigured. */
const IDLE_POLL_SECONDS = 30;

export function getWebullSyncConfig(): WebullSyncConfig {
  const s = getSetting<Partial<WebullSyncConfig>>(SETTING_KEY) ?? {};
  const raw = Number(s.intervalSeconds);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT.enabled,
    intervalSeconds: Math.max(MIN_SYNC_INTERVAL_SECONDS, Number.isFinite(raw) ? raw : DEFAULT.intervalSeconds),
    accountId: typeof s.accountId === 'string' && s.accountId.trim() !== '' ? s.accountId.trim() : null,
  };
}

export function setWebullSyncConfig(patch: Partial<WebullSyncConfig>): WebullSyncConfig {
  const current = getWebullSyncConfig();
  const next: WebullSyncConfig = {
    enabled: patch.enabled ?? current.enabled,
    intervalSeconds: Math.max(MIN_SYNC_INTERVAL_SECONDS, patch.intervalSeconds ?? current.intervalSeconds),
    accountId:
      patch.accountId !== undefined
        ? patch.accountId && patch.accountId.trim() !== ''
          ? patch.accountId.trim()
          : null
        : current.accountId,
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

/** One sync pass — exposed for tests/manual triggering. Returns null (a
 *  no-op, not an error) while disabled or before an account id is set. */
export async function runSchedulerTick(): Promise<WebullFullSyncResult | null> {
  const cfg = getWebullSyncConfig();
  if (!cfg.enabled || !cfg.accountId) return null;
  return syncWebullAccount(cfg.accountId);
}

let timer: NodeJS.Timeout | null = null;
let started = false;

async function loop(): Promise<void> {
  const cfg = getWebullSyncConfig();
  const active = cfg.enabled && !!cfg.accountId;
  if (active) {
    try {
      await runSchedulerTick();
    } catch (e) {
      console.error('[webull-positions-scheduler]', (e as Error).message);
    }
  }
  const delaySec = active ? cfg.intervalSeconds : IDLE_POLL_SECONDS;
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
