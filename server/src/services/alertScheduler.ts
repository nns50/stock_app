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
  if (!events.length) return;
  // Read the delivery result rather than dropping it. dispatchNotifications
  // never throws and reports per-channel outcomes its own doc calls something
  // "the caller can log/surface" — and no caller did, here or anywhere else.
  // So an expired Slack URL or a revoked Discord app silently swallowed every
  // price alert, and a broken notifier looked exactly like a quiet market.
  //
  // console only, deliberately: this poller has no journal of its own, and the
  // autotrade events feed is a different subsystem's. A zero-channel setup
  // means "notifications are off", not a failure, so it is not reported.
  const outcome = await dispatchNotifications(events);
  if (outcome.results.length > 0 && !outcome.delivered) {
    console.error(
      '[alert-scheduler] every configured webhook failed — %d alert(s) reached nobody: %s',
      events.length,
      outcome.results.map((r) => `${r.label}: ${r.error ?? 'failed'}`).join('; '),
    );
  }
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
  let delaySec = DISABLED_POLL_SECONDS;
  try {
    const cfg = getSchedulerConfig();
    // Cadence decided before the tick runs, so a failed tick still re-polls on
    // the configured interval instead of the disabled fallback.
    delaySec = cfg.enabled ? cfg.intervalSeconds : DISABLED_POLL_SECONDS;
    if (cfg.enabled) await runSchedulerTick();
  } catch (e) {
    console.error('[alert-scheduler]', e instanceof Error ? e.message : e);
  }
  // stopAlertScheduler() during an in-flight tick used to be undone right
  // here: clearTimeout only cancels the PENDING timer, and this line then
  // scheduled a fresh one. Shutdown/tests rely on stop meaning stopped.
  if (!started) return;
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
