// Desktop (browser) notifications for triggered alerts. Opt-in and permission-
// gated: the user enables it in Settings (which requests permission), and we only
// notify when the tab is in the background — when it's focused, the in-app toast
// already does the job, so we don't double-notify.

export const NOTIFY_KEY = 'alerts.notify';

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Whether desktop notifications are switched on AND permission is granted. */
export function notificationsEnabled(): boolean {
  if (!supported()) return false;
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'true' && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

/** Ask the browser for permission; resolves true only if granted. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!supported()) return false;
  try {
    if (Notification.permission === 'granted') return true;
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

/** Fire a desktop notification when enabled and the tab isn't currently visible. */
export function notifyAlert(title: string, body: string): void {
  if (!notificationsEnabled()) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  try {
    new Notification(title, { body, tag: 'stock-app-alert' });
  } catch {
    /* ignore — some environments reject construction */
  }
}
