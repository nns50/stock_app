import { config } from '../config';

// ---------------------------------------------------------------------------
// Outbound notifications for alerts that fire while no browser tab is open.
// v1 channel: a single outgoing webhook (POST JSON). The payload shape adapts to
// the target — Slack (`text`), Discord (`content`), or a generic envelope — so
// the URL works out of the box with the common services (and reaches a phone via
// ntfy / a chat app). Zero dependencies: Node's global fetch. Secrets (the URL)
// live in server/.env, never the DB.
// ---------------------------------------------------------------------------

export type WebhookFormat = 'json' | 'slack' | 'discord';

export interface NotifyEvent {
  /** Short subject (symbol or contract). */
  title: string;
  /** The full alert line. */
  message: string;
}

export interface NotificationStatus {
  webhook: { configured: boolean; format: WebhookFormat };
}

export interface DispatchResult {
  delivered: boolean;
  channel?: 'webhook';
  /** Number of events sent. */
  count?: number;
  error?: string;
}

/** Build the request body for the configured webhook format (pure). */
export function buildWebhookPayload(events: NotifyEvent[], format: WebhookFormat): unknown {
  const heading = `🔔 ${events.length} alert${events.length === 1 ? '' : 's'}`;
  const text = [heading, ...events.map((e) => `• ${e.message}`)].join('\n');
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text };
  return { title: heading, text, events };
}

/** Non-secret status for the UI (is a webhook wired up, and in what format). */
export function notificationStatus(): NotificationStatus {
  return { webhook: { configured: !!config.notifications.webhookUrl, format: config.notifications.webhookFormat } };
}

/**
 * POST the events to the configured webhook. Never throws — returns a result the
 * caller can log/surface; a missing URL or a network/HTTP error just means
 * `delivered: false`.
 */
export async function dispatchNotifications(events: NotifyEvent[]): Promise<DispatchResult> {
  if (events.length === 0) return { delivered: false, count: 0 };
  const { webhookUrl, webhookFormat } = config.notifications;
  if (!webhookUrl) return { delivered: false, error: 'no webhook configured', count: events.length };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(events, webhookFormat)),
    });
    if (!res.ok) return { delivered: false, channel: 'webhook', error: `HTTP ${res.status}`, count: events.length };
    return { delivered: true, channel: 'webhook', count: events.length };
  } catch (e) {
    return { delivered: false, channel: 'webhook', error: (e as Error).message, count: events.length };
  }
}
