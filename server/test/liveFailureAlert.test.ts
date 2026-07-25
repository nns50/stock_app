import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));

import { initDb, db } from '../src/db';
import { logAutotradeEvent, listAutotradeEvents } from '../src/db/autotradeEvents';
import { dispatchNotifications } from '../src/services/notifier';
import {
  maybeAlertLiveOrderFailures,
  LIVE_FAILURE_ALERT_THRESHOLD,
  LIVE_FAILURE_REALERT_COOLDOWN_MS,
} from '../src/services/autotrading/liveFailureAlert';

const mockDispatch = vi.mocked(dispatchNotifications);

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events');
  mockDispatch.mockClear();
});

function fail(symbol = 'KC', reason = 'Price increment should be 0.01 when price is equal to or greater than 0.9999') {
  logAutotradeEvent({ symbol, stage: 'execution', action: 'live_entry_failed', detail: { reason } });
}
function failN(n: number) {
  for (let i = 0; i < n; i++) fail();
}
function placed(symbol = 'MSFT') {
  logAutotradeEvent({ symbol, stage: 'execution', action: 'live_order_placed', detail: { orderId: 'WB-1' } });
}
const alertMarkers = () => listAutotradeEvents({ actions: ['live_failure_alerted'] });

describe('maybeAlertLiveOrderFailures', () => {
  it('does not alert below the threshold', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD - 1);
    expect(await maybeAlertLiveOrderFailures()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(alertMarkers()).toHaveLength(0);
  });

  it('alerts once at the threshold, journals a marker, and names the latest symbol + reason', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    expect(await maybeAlertLiveOrderFailures()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const events = mockDispatch.mock.calls[0][0];
    expect(events[0].message).toMatch(new RegExp(`${LIVE_FAILURE_ALERT_THRESHOLD} live order attempts REJECTED`));
    expect(events[0].message).toMatch(/KC/);
    expect(events[0].message).toMatch(/Price increment should be 0\.01/);
    expect(alertMarkers()).toHaveLength(1);
  });

  it('counts equity, options-entry, and options-exit rejections in the same streak', async () => {
    logAutotradeEvent({ symbol: 'A', stage: 'execution', action: 'live_entry_failed', detail: { reason: 'x' } });
    logAutotradeEvent({
      symbol: 'B',
      stage: 'execution',
      action: 'live_options_entry_failed',
      detail: { reason: 'y' },
    });
    logAutotradeEvent({ symbol: 'C', stage: 'execution', action: 'live_options_exit_failed', detail: { reason: 'z' } });
    expect(await maybeAlertLiveOrderFailures()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('a successful placement resets the streak (failures before it do not count)', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD); // would alert...
    placed(); // ...but a real order got through
    failN(LIVE_FAILURE_ALERT_THRESHOLD - 1); // and only sub-threshold failures since
    expect(await maybeAlertLiveOrderFailures()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not re-alert for the same streak within the cooldown', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    expect(await maybeAlertLiveOrderFailures()).toBe(true);
    mockDispatch.mockClear();
    fail(); // streak continues
    expect(await maybeAlertLiveOrderFailures()).toBe(false); // throttled
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(alertMarkers()).toHaveLength(1);
  });

  it('re-alerts once the cooldown has elapsed and the streak still persists', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    await maybeAlertLiveOrderFailures();
    const marker = alertMarkers()[0];
    mockDispatch.mockClear();
    fail();
    const afterCooldown = marker.createdAt + LIVE_FAILURE_REALERT_COOLDOWN_MS + 1000;
    expect(await maybeAlertLiveOrderFailures(afterCooldown)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(alertMarkers()).toHaveLength(2);
  });

  it('a success after an alert starts a fresh streak that can alert again', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    await maybeAlertLiveOrderFailures(); // alert #1
    placed(); // reset
    mockDispatch.mockClear();
    failN(LIVE_FAILURE_ALERT_THRESHOLD - 1);
    expect(await maybeAlertLiveOrderFailures()).toBe(false); // sub-threshold since reset
    fail();
    expect(await maybeAlertLiveOrderFailures()).toBe(true); // fresh streak hit the threshold
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('ignores guardrail BLOCKS — those are the system correctly refusing, not a broker rejection', async () => {
    for (let i = 0; i < LIVE_FAILURE_ALERT_THRESHOLD + 2; i++) {
      logAutotradeEvent({
        symbol: 'X',
        stage: 'execution',
        action: 'live_entry_blocked',
        detail: { reasons: 'kill_switch' },
      });
    }
    expect(await maybeAlertLiveOrderFailures()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
