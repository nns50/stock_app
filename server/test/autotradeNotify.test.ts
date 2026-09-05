import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../src/services/notifier', () => ({ dispatchNotifications: vi.fn() }));

import { initDb, db } from '../src/db';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { dispatchNotifications } from '../src/services/notifier';
import { dispatchAutotradeNotification } from '../src/services/autotrading/notify';

const mockDispatch = vi.mocked(dispatchNotifications);
const events = [{ title: 'T', message: 'M' }];
const failures = () => listAutotradeEvents({ stage: 'execution', actions: ['notification_delivery_failed'] });

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events;');
  mockDispatch.mockReset();
});

// dispatchNotifications never throws and returns a per-channel result its own
// doc calls something "the caller can log/surface" — and no caller did, at any
// of the sixteen call sites. So every configured webhook failing meant the
// operator got nothing AND nothing recorded that the message was lost: a
// broken notifier looked exactly like a quiet week.
describe('dispatchAutotradeNotification', () => {
  it('journals when EVERY channel failed, naming the alert and the errors', async () => {
    mockDispatch.mockResolvedValue({
      delivered: false,
      count: 1,
      results: [
        { label: 'slack', delivered: false, error: 'HTTP 404' },
        { label: 'discord', delivered: false, error: 'HTTP 401' },
      ],
    });

    await dispatchAutotradeNotification('daily drawdown halt', events);

    const rows = failures();
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0].detail!);
    expect(detail.context).toBe('daily drawdown halt');
    expect(detail.channels).toEqual([
      { label: 'slack', error: 'HTTP 404' },
      { label: 'discord', error: 'HTTP 401' },
    ]);
  });

  it('stays quiet when at least one channel delivered', async () => {
    // A partial failure still reached someone. A row for every one of those
    // would train the feed to be ignored, which is how a real outage is missed.
    mockDispatch.mockResolvedValue({
      delivered: true,
      count: 1,
      results: [
        { label: 'slack', delivered: true },
        { label: 'discord', delivered: false, error: 'HTTP 500' },
      ],
    });

    await dispatchAutotradeNotification('auto-tune', events);

    expect(failures()).toHaveLength(0);
  });

  it('stays quiet when notifications are simply switched off', async () => {
    // Zero channels reports delivered:false too, but that is "off", not a
    // failure — journaling it on every alert would be pure noise for anyone
    // who never configured a webhook.
    mockDispatch.mockResolvedValue({ delivered: false, count: 1, results: [] });

    await dispatchAutotradeNotification('live equity', events);

    expect(failures()).toHaveLength(0);
  });
});
