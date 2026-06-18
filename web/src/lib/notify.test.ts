import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyAlert, notificationsEnabled, NOTIFY_KEY } from './notify';

class MockNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  static instances: MockNotification[] = [];
  constructor(
    public title: string,
    public opts?: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  MockNotification.instances = [];
  MockNotification.permission = 'granted';
  vi.stubGlobal('Notification', MockNotification);
});
afterEach(() => vi.unstubAllGlobals());

describe('notifyAlert', () => {
  it('does nothing when the user has not enabled notifications', () => {
    setVisibility('hidden');
    notifyAlert('t', 'b');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('fires when enabled, permitted, and the tab is hidden', () => {
    localStorage.setItem(NOTIFY_KEY, 'true');
    setVisibility('hidden');
    notifyAlert('Alert triggered', 'AAPL above 200');
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('Alert triggered');
    expect(MockNotification.instances[0].opts?.body).toBe('AAPL above 200');
  });

  it('stays quiet when the tab is visible (the in-app toast suffices)', () => {
    localStorage.setItem(NOTIFY_KEY, 'true');
    setVisibility('visible');
    notifyAlert('t', 'b');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('respects a denied permission', () => {
    localStorage.setItem(NOTIFY_KEY, 'true');
    MockNotification.permission = 'denied';
    setVisibility('hidden');
    expect(notificationsEnabled()).toBe(false);
    notifyAlert('t', 'b');
    expect(MockNotification.instances).toHaveLength(0);
  });
});
