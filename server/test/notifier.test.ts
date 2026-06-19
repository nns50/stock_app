import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import {
  buildWebhookPayload,
  dispatchNotifications,
  notificationStatus,
  webhookChannels,
  NotifyEvent,
} from '../src/services/notifier';

const events: NotifyEvent[] = [
  { title: 'AAPL', message: 'AAPL price $150.00 is above $145.00' },
  { title: 'TSLA 250P', message: 'TSLA 250P 2026-07-17 option mark $3.20 is above $3.00' },
];

const orig = { ...config.notifications };
afterEach(() => {
  Object.assign(config.notifications, orig);
  vi.restoreAllMocks();
});

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
    const p = buildWebhookPayload(events, 'json') as { title: string; events: NotifyEvent[] };
    expect(p.events).toHaveLength(2);
    expect(p.title).toContain('2 alerts');
  });

  it('uses a singular heading for one event', () => {
    const p = buildWebhookPayload([events[0]], 'slack') as { text: string };
    expect(p.text).toContain('🔔 1 alert');
    expect(p.text).not.toContain('1 alerts');
  });
});

describe('webhookChannels', () => {
  it('builds Slack + Discord + generic from config', () => {
    Object.assign(config.notifications, {
      slackWebhookUrl: 'http://slack.test',
      discordWebhookUrl: 'http://discord.test',
      webhookUrl: 'http://ntfy.test',
      webhookFormat: 'json',
    });
    const channels = webhookChannels();
    expect(channels.map((c) => c.label)).toEqual(['slack', 'discord', 'webhook']);
    expect(channels[0]).toMatchObject({ url: 'http://slack.test', format: 'slack' });
    expect(channels[1]).toMatchObject({ url: 'http://discord.test', format: 'discord' });
  });

  it('omits unconfigured destinations', () => {
    Object.assign(config.notifications, { slackWebhookUrl: '', discordWebhookUrl: 'http://d', webhookUrl: '' });
    expect(webhookChannels().map((c) => c.label)).toEqual(['discord']);
  });
});

describe('notificationStatus', () => {
  it('lists configured channels without leaking URLs', () => {
    Object.assign(config.notifications, { slackWebhookUrl: 'http://s', discordWebhookUrl: 'http://d', webhookUrl: '' });
    const s = notificationStatus();
    expect(s.configured).toBe(true);
    expect(s.channels).toEqual([
      { label: 'slack', format: 'slack' },
      { label: 'discord', format: 'discord' },
    ]);
    expect(JSON.stringify(s)).not.toContain('http://');
  });

  it('reports not-configured when nothing is set', () => {
    Object.assign(config.notifications, { slackWebhookUrl: '', discordWebhookUrl: '', webhookUrl: '' });
    expect(notificationStatus().configured).toBe(false);
  });
});

describe('dispatchNotifications', () => {
  it('no-ops (no fetch) when nothing is configured', async () => {
    Object.assign(config.notifications, { slackWebhookUrl: '', discordWebhookUrl: '', webhookUrl: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(false);
    expect(r.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops on empty events', async () => {
    Object.assign(config.notifications, { slackWebhookUrl: 'http://s' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await dispatchNotifications([]);
    expect(r.delivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fans out to Slack and Discord at once', async () => {
    Object.assign(config.notifications, {
      slackWebhookUrl: 'http://slack.test',
      discordWebhookUrl: 'http://discord.test',
      webhookUrl: '',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(true);
    expect(r.count).toBe(2);
    expect(r.results).toEqual([
      { label: 'slack', delivered: true },
      { label: 'discord', delivered: true },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['http://slack.test', 'http://discord.test']);
  });

  it('reports a partial failure per channel without throwing', async () => {
    Object.assign(config.notifications, {
      slackWebhookUrl: 'http://slack.test',
      discordWebhookUrl: 'http://discord.test',
      webhookUrl: '',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('discord')
        ? ({ ok: false, status: 404 } as Response)
        : ({ ok: true, status: 200 } as Response),
    );
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(true); // slack succeeded
    expect(r.results).toEqual([
      { label: 'slack', delivered: true },
      { label: 'discord', delivered: false, error: 'HTTP 404' },
    ]);
  });

  it('captures a network error on a channel', async () => {
    Object.assign(config.notifications, {
      slackWebhookUrl: 'http://slack.test',
      discordWebhookUrl: '',
      webhookUrl: '',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await dispatchNotifications(events);
    expect(r.delivered).toBe(false);
    expect(r.results[0]).toMatchObject({ label: 'slack', delivered: false });
    expect(r.results[0].error).toContain('ECONNREFUSED');
  });
});
