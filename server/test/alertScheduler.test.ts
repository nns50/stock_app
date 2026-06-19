import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  collectEvents,
  getSchedulerConfig,
  setSchedulerConfig,
  stopAlertScheduler,
  MIN_INTERVAL_SECONDS,
} from '../src/services/alertScheduler';

beforeAll(() => initDb());
beforeEach(() => {
  stopAlertScheduler(); // clears the de-dup memory between tests
  db.exec("DELETE FROM settings WHERE key = 'alertScheduler'");
});

describe('scheduler config', () => {
  it('defaults to disabled at 60s', () => {
    expect(getSchedulerConfig()).toEqual({ enabled: false, intervalSeconds: 60 });
  });

  it('clamps the interval to the minimum', () => {
    const saved = setSchedulerConfig({ enabled: true, intervalSeconds: 1 });
    expect(saved).toEqual({ enabled: true, intervalSeconds: MIN_INTERVAL_SECONDS });
    expect(getSchedulerConfig().intervalSeconds).toBe(MIN_INTERVAL_SECONDS);
  });

  it('merges a partial patch (keeps the unspecified field)', () => {
    setSchedulerConfig({ enabled: true, intervalSeconds: 120 });
    const saved = setSchedulerConfig({ intervalSeconds: 300 });
    expect(saved).toEqual({ enabled: true, intervalSeconds: 300 });
  });
});

const base = { alerts: [], newlyTriggered: [], positionAlerts: [], checkedAt: 0 };

describe('collectEvents', () => {
  it('emits one event per newly-triggered alert', () => {
    const events = collectEvents({ ...base, newlyTriggered: [{ id: 1, symbol: 'AAPL', message: 'AAPL fired' }] });
    expect(events).toEqual([{ title: 'AAPL', message: 'AAPL fired' }]);
  });

  it('de-dupes a standing position-exit alert across ticks', () => {
    const pa = [{ positionId: 7, symbol: 'TSLA', rule: 'stop-hit', unrealizedPct: -10, message: 'TSLA stop hit' }];
    expect(collectEvents({ ...base, positionAlerts: pa })).toHaveLength(1);
    expect(collectEvents({ ...base, positionAlerts: pa })).toHaveLength(0); // already notified
  });

  it('re-emits a position-exit alert that cleared and recurred', () => {
    const pa = [{ positionId: 8, symbol: 'NVDA', rule: 'target-hit', unrealizedPct: 20, message: 'NVDA target' }];
    collectEvents({ ...base, positionAlerts: pa }); // notified
    collectEvents({ ...base, positionAlerts: [] }); // cleared → forgotten
    expect(collectEvents({ ...base, positionAlerts: pa })).toHaveLength(1);
  });
});
