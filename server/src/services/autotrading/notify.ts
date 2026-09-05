import { logAutotradeEvent } from '../../db/autotradeEvents';
import { dispatchNotifications, NotifyEvent } from '../notifier';

// ---------------------------------------------------------------------------
// Autotrade's notification send, with the delivery result actually read.
//
// dispatchNotifications never throws and returns a per-channel DispatchResult
// that its own doc comment describes as something "the caller can log/surface".
// No autotrade caller did. All sixteen call sites across the app were
// `await dispatchNotifications([...])` with the result dropped on the floor.
//
// So if every configured webhook fails — an expired Slack URL, a revoked
// Discord app, a rate limit, a network blip — the operator gets nothing, and
// nothing anywhere records that the message was lost. That is the worst variant
// of this codebase's recurring disease: a value computed and read by nothing,
// where the value in question is "did the thing that tells you about problems
// actually work". Every alert would go quiet at once and look exactly like a
// quiet week.
//
// Journaling is the right channel for this specific failure precisely because
// the push channel is the thing that broke: the events feed is in the app, and
// it is where "why did nothing alert me?" gets asked. logAutotradeEvent does
// not itself notify, so there is no recursion.
//
// Only TOTAL failure is journalled. One channel of two failing still delivered
// the message, and a row per partial failure would train the feed to be
// ignored — which is how a real outage gets missed.
// ---------------------------------------------------------------------------

/**
 * Send an autotrade notification and record it if nothing was delivered.
 *
 * `context` names the alert, so the journal row says WHICH message was lost
 * rather than just that one was.
 */
export async function dispatchAutotradeNotification(context: string, events: NotifyEvent[]): Promise<void> {
  const result = await dispatchNotifications(events);
  // A zero-channel setup is "notifications are off", not a delivery failure —
  // dispatchNotifications reports delivered:false for it, and journaling that
  // on every alert would be pure noise for anyone who never configured one.
  if (result.results.length === 0) return;
  if (result.delivered) return;
  logAutotradeEvent({
    stage: 'execution',
    action: 'notification_delivery_failed',
    detail: {
      context,
      title: events[0]?.title ?? null,
      channels: result.results.map((r) => ({ label: r.label, error: r.error ?? null })),
      reason: 'every configured webhook failed — this alert did not reach anyone',
    },
  });
}
