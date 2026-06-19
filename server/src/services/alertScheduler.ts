import { getSetting, setSetting } from '../db/settings';
import { runAlertEvaluation } from './alertRun';
import { dispatchNotifications, NotifyEvent } from './notifier';

// ---------------------------------------------------------------------------
// Background alert poller. A single self-scheduling loop evaluates alerts on the
// server — independent of any open browser tab — and pushes newly-fired alerts
// to the configured webhook. Off by default; the interval/enable live in a
// setting (UI-toggleable), so the loop re-reads them each cycle and adjusts
// without a restart. Symbol/option alerts are one-shot in the DB, so they notify
// once; stateless position-exit alerts are de-duplicated here.
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  enabled: boolean;
  intervalSeconds: number;
}

const SETTING_KEY = 'alertScheduler';
const DEFAULT: SchedulerConfig = { enabled: false, intervalSeconds: 60 };
/** Floor on the interval, to respect provider rate limits. */
export const MIN_INTERVAL_SECONDS = 15;
/** How often to re-check the setting while disabled. */
const DISABLED_POLL_SECONDS = 30;

export function getSchedulerConfig(): SchedulerConfig {
  const s = getSetting<Partial<SchedulerConfig>>(SETTING_KEY) ?? {};
  const raw = Number(s.intervalSeconds);
  return {
    enabled: !!s.enabled,
    intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, Number.isFinite(raw) ? raw : DEFAULT.intervalSeconds),
  };
}

export function setSchedulerConfig(patch: Partial<SchedulerConfig>): SchedulerConfig {
  const current = getSchedulerConfig();
  const next: SchedulerConfig = {
    enabled: patch.enabled ?? current.enabled,
    intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, patch.intervalSeconds ?? current.intervalSeconds),
  };
  setSetting(SETTING_KEY, next);
  return next;
}

// Position-exit alerts are recomputed every tick; remember which we've already
// pushed so a standing exit notifies once but can re-fire if it clears and recurs.
const notifiedExitKeys = new Set<string>();

/** Turn an evaluation result into the notify events not yet sent. */
export function collectEvents(result: Awaited<ReturnType<typeof runAlertEvaluation>>): NotifyEvent[] {
  const events: NotifyEvent[] = [];
  for (const t of result.newlyTriggered) {
    events.push({ title: t.symbol, message: t.message || `${t.symbol} triggered` });
  }
  const seen = new Set<string>();
  for (const e of result.positionAlerts) {
    const key = `${e.positionId}:${e.rule}`;
    seen.add(key);
    if (!notifiedExitKeys.has(key)) events.push({ title: e.symbol, message: e.message });
  }
  notifiedExitKeys.clear();
  for (const k of seen) notifiedExitKeys.add(k);
  return events;
}

/** One evaluation + dispatch pass. Exposed for tests. */
export async function runSchedulerTick(): Promise<void> {
  const result = await runAlertEvaluation();
  const events = collectEvents(result);
  if (events.length) await dispatchNotifications(events);
}

let timer: NodeJS.Timeout | null = null;
let started = false;

async function loop(): Promise<void> {
  const cfg = getSchedulerConfig();
  if (cfg.enabled) {
    try {
      await runSchedulerTick();
    } catch (e) {
      console.error('[alert-scheduler]', (e as Error).message);
    }
  }
  const delaySec = cfg.enabled ? cfg.intervalSeconds : DISABLED_POLL_SECONDS;
  timer = setTimeout(() => void loop(), delaySec * 1000);
  timer.unref?.(); // don't keep the process alive on the timer alone
}

/** Start the poll loop (idempotent). Call once after the server starts. */
export function startAlertScheduler(): void {
  if (started) return;
  started = true;
  timer = setTimeout(() => void loop(), 1000);
  timer.unref?.();
}

/** Stop the loop (tests / shutdown). */
export function stopAlertScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  notifiedExitKeys.clear();
}
