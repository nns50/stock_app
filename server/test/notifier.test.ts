import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { buildWebhookPayload, dispatchNotifications, notificationStatus, NotifyEvent } from '../src/services/notifier';

const events: NotifyEvent[] = [
  { title: 'AAPL', message: 'AAPL price $150.00 is above $145.00' },
  { title: 'TSLA 250P', message: 'TSLA 250P 2026-07-17 option mark $3.20 is above $3.00' },
];

describe('buildWebhookPayload', () => {
  it('formats Slack as { text }', () => {
    const p = buildWebhookPayload(events, 'slack') as { text: string };
    expect(p.text).toContain('🔔 2 alerts');
    expect(p.text).toContain('• AAPL price');
  });

  it('formats Discord as { content }', () => {
    const p = buildWebhookPayload(events, 'discord') as { content: string };
    expect(p.content).toContain('• TSLA 250P');
  });

  it('formats generic JSON with structured events', () => {
    const p = buildWebhookPayload(events, 'json') as { title: string; text: string; events: NotifyEvent[] };
    expect(p.events).toHaveLength(2);
    expect(p.title).toContain('2 alerts');
  });

  it('uses a singular heading for one event', () => {
    const p = buildWebhookPayload([events[0]], 'slack') as { text: string };
    expect(p.text).toContain('🔔 1 alert');
    expect(p.text).not.toContain('1 alerts');
  });
});

describe('dispatchNotifications', () => {
  const orig = config.notifications.webhookUrl;
  afterEach(() => {
    config.notifications.webhookUrl = orig;
    vi.restoreAllMocks();
  });

  it('no-ops (no fetch) when no webhook is configured', async () => {
    config.notifications.webhookUrl = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops on empty events', async () => {
    config.notifications.webhookUrl = 'http://hook.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await dispatchNotifications([]);
    expect(r.delivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the webhook and reports delivered', async () => {
    config.notifications.webhookUrl = 'http://hook.test/abc';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    const r = await dispatchNotifications(events);
    expect(r).toMatchObject({ delivered: true, channel: 'webhook', count: 2 });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://hook.test/abc');
    expect(init?.method).toBe('POST');
  });

  it('reports an HTTP error without throwing', async () => {
    config.notifications.webhookUrl = 'http://hook.test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('500');
  });

  it('reports a network error without throwing', async () => {
    config.notifications.webhookUrl = 'http://hook.test';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('notificationStatus', () => {
  const orig = config.notifications.webhookUrl;
  afterEach(() => {
    config.notifications.webhookUrl = orig;
  });
  it('reflects whether a webhook is configured', () => {
    config.notifications.webhookUrl = 'http://x';
    expect(notificationStatus().webhook.configured).toBe(true);
    config.notifications.webhookUrl = '';
    expect(notificationStatus().webhook.configured).toBe(false);
  });
});
