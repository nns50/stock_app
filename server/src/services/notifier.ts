import { config } from '../config';

// ---------------------------------------------------------------------------
// Outbound notifications for alerts that fire while no browser tab is open.
// Each configured webhook is a destination an alert fans out to, so Slack +
// Discord + a generic/ntfy webhook can all fire at once. The payload shape
// adapts per target — Slack (`text`), Discord (`content`), or a generic
// envelope. Zero dependencies: Node's global fetch. Secrets (the URLs) live in
// server/.env, never the DB.
// ---------------------------------------------------------------------------

export type WebhookFormat = 'json' | 'slack' | 'discord';

export interface WebhookChannel {
  /** Stable label for status/results (e.g. 'slack', 'discord', 'webhook'). */
  label: string;
  url: string;
  format: WebhookFormat;
}

export interface NotifyEvent {
  /** Short subject (symbol or contract). */
  title: string;
  /** The full alert line. */
  message: string;
}

export interface NotificationStatus {
  /** Configured destinations (no URLs — those are secret). */
  channels: { label: string; format: WebhookFormat }[];
  configured: boolean;
}

export interface ChannelResult {
  label: string;
  delivered: boolean;
  error?: string;
}

export interface DispatchResult {
  /** True if at least one channel accepted the post. */
  delivered: boolean;
  /** Number of events sent. */
  count: number;
  results: ChannelResult[];
}

/** The configured webhook destinations, in fan-out order. */
export function webhookChannels(): WebhookChannel[] {
  const n = config.notifications;
  const out: WebhookChannel[] = [];
  if (n.slackWebhookUrl) out.push({ label: 'slack', url: n.slackWebhookUrl, format: 'slack' });
  if (n.discordWebhookUrl) out.push({ label: 'discord', url: n.discordWebhookUrl, format: 'discord' });
  if (n.webhookUrl) out.push({ label: 'webhook', url: n.webhookUrl, format: n.webhookFormat });
  return out;
}

/** Build the request body for a given webhook format (pure). */
export function buildWebhookPayload(events: NotifyEvent[], format: WebhookFormat): unknown {
  const heading = `🔔 ${events.length} alert${events.length === 1 ? '' : 's'}`;
  const text = [heading, ...events.map((e) => `• ${e.message}`)].join('\n');
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text };
  return { title: heading, text, events };
}

/** Non-secret status for the UI (which destinations are wired up). */
export function notificationStatus(): NotificationStatus {
  const channels = webhookChannels().map((c) => ({ label: c.label, format: c.format }));
  return { channels, configured: channels.length > 0 };
}

async function postOne(channel: WebhookChannel, events: NotifyEvent[]): Promise<ChannelResult> {
  try {
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(events, channel.format)),
    });
    return res.ok
      ? { label: channel.label, delivered: true }
      : { label: channel.label, delivered: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { label: channel.label, delivered: false, error: (e as Error).message };
  }
}

/**
 * Fan the events out to every configured webhook. Never throws — returns a
 * per-channel result the caller can log/surface. A missing URL or a network/HTTP
 * error on one channel doesn't stop the others.
 */
export async function dispatchNotifications(events: NotifyEvent[]): Promise<DispatchResult> {
  if (events.length === 0) return { delivered: false, count: 0, results: [] };
  const channels = webhookChannels();
  if (channels.length === 0) return { delivered: false, count: events.length, results: [] };
  const results = await Promise.all(channels.map((c) => postOne(c, events)));
  return { delivered: results.some((r) => r.delivered), count: events.length, results };
}
