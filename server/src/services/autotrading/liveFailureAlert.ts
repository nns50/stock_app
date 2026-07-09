import { listAutotradeEvents, logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications } from '../notifier';

// ---------------------------------------------------------------------------
// Repeated live-order-rejection alerting.
//
// The sub-penny bracket bug rejected 2000+ live entries before anyone noticed,
// because nothing surfaced a SYSTEMIC run of live-order rejections — only a
// successful placement (and a kill-switch engage) ever pushed a notification.
// This closes that gap: when live orders keep getting rejected in a row, one
// throttled alert fires through the SAME Slack/Discord/webhook infra the rest
// of the app already uses.
//
// Scope is deliberately the BROKER/QUOTE REJECTION class (`*_failed`) — an
// order we actually tried to place and the broker (or a missing quote) refused
// — NOT guardrail BLOCKS (`*_blocked`), which are the system correctly
// refusing (a kill switch, a daily cap): those are expected, and the kill
// switch already alerts on its own engage. A one-off rejection is normal market
// friction; a RUN of them means something is systemically wrong (a bad price, a
// broker/account problem, a config error) and no live trades are getting
// through.
//
// Derived entirely from the append-only journal (restart-safe; no separate
// counter that could drift from what actually happened): count consecutive
// rejections since the last successful placement, alert once at the threshold,
// then re-remind at most hourly until a success resets the streak.
// ---------------------------------------------------------------------------

/** A real live order the broker REJECTED (webullPlaceOrder returned !ok), or a
 *  close we couldn't even price — the anomaly class this alert exists for. */
const FAILURE_ACTIONS = ['live_entry_failed', 'live_options_entry_failed', 'live_options_exit_failed'];
/** A real live order that reached the broker — resets the failure streak. */
const SUCCESS_ACTIONS = ['live_order_placed', 'live_options_order_placed'];
/** Our own "we alerted" marker, journaled so the throttle survives a restart. */
const ALERT_ACTION = 'live_failure_alerted';

/** Fire once this many live orders are rejected in a row. A single rejection is
 *  normal; a run of them is systemic. */
export const LIVE_FAILURE_ALERT_THRESHOLD = 3;
/** While a failing streak persists, re-remind at most this often — so a
 *  multi-hour outage pages again, but the same streak never spams. */
export const LIVE_FAILURE_REALERT_COOLDOWN_MS = 60 * 60_000;

function reasonOf(detail: string | null): string {
  if (!detail) return 'no reason reported';
  try {
    const parsed = JSON.parse(detail) as { reason?: unknown };
    if (typeof parsed.reason === 'string' && parsed.reason) return parsed.reason;
  } catch {
    // detail wasn't JSON — use it verbatim.
  }
  return detail;
}

/**
 * Surface a systemic run of live-order rejections through the notifier. Reads
 * the journal (newest-first), counts consecutive rejections since the last
 * successful placement, and — if that count is at/above the threshold and we
 * haven't already alerted for this same streak within the cooldown — dispatches
 * one alert and journals a marker. A success between rejections resets
 * everything. Best-effort and never throws (dispatchNotifications() is itself a
 * no-op with zero channels configured). Returns true iff it dispatched.
 *
 * `now` is injectable for tests.
 */
export async function maybeAlertLiveOrderFailures(now: number = Date.now()): Promise<boolean> {
  // Only the live-order OUTCOME + our own alert-marker events, newest-first —
  // filtering by action (not just stage) so the window reliably reaches back
  // past the last alert marker even during heavy execution-event activity.
  const events = listAutotradeEvents({
    stage: 'execution',
    actions: [...FAILURE_ACTIONS, ...SUCCESS_ACTIONS, ALERT_ACTION],
    limit: 100,
  });

  let consecutiveFailures = 0;
  let latest: { symbol: string | null; reason: string } | null = null;
  let lastAlertAt: number | null = null;
  for (const e of events) {
    if (SUCCESS_ACTIONS.includes(e.action)) break; // the streak ends at the most recent real placement
    if (e.action === ALERT_ACTION) {
      if (lastAlertAt === null) lastAlertAt = e.createdAt; // most recent alert in THIS streak
      continue;
    }
    // A failure action.
    consecutiveFailures++;
    if (!latest) latest = { symbol: e.symbol, reason: reasonOf(e.detail) };
  }

  if (consecutiveFailures < LIVE_FAILURE_ALERT_THRESHOLD) return false;
  // Already alerted for this (post-success) streak and still within the cooldown.
  if (lastAlertAt !== null && now - lastAlertAt < LIVE_FAILURE_REALERT_COOLDOWN_MS) return false;

  const symbol = latest?.symbol ?? 'unknown';
  const reason = latest?.reason ?? 'no reason reported';
  // Journal the marker BEFORE dispatching so the throttle holds even if the
  // dispatch is slow and another tick runs (the journal is the source of truth).
  logAutotradeEvent({
    stage: 'execution',
    action: ALERT_ACTION,
    detail: { consecutiveFailures, latestSymbol: symbol, latestReason: reason },
  });
  await dispatchNotifications([
    {
      title: 'Autotrade live orders failing',
      message:
        `⚠️ ${consecutiveFailures} live order attempts REJECTED in a row — no live trades are ` +
        `getting through. Latest: ${symbol} — ${reason}. Check the Auto-Trade page.`,
    },
  ]);
  return true;
}
