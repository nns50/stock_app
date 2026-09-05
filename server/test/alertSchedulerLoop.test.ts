import { describe, it, expect, afterEach, vi } from 'vitest';

// Loop LIFECYCLE tests — the self-re-arming timer behavior itself, with the
// tick and config mocked out. The same guarded-loop pattern is deliberately
// copy-identical in webullPositionsScheduler.ts and autotrading/loop.ts;
// this file proves the pattern's behavior once, where it's cheapest to
// control. (alertScheduler.test.ts covers config/collect logic separately.)
vi.mock('../src/db/settings', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock('../src/services/alertRun', () => ({ runAlertEvaluation: vi.fn() }));
vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));

import { getSetting } from '../src/db/settings';
import { runAlertEvaluation } from '../src/services/alertRun';
import { startAlertScheduler, stopAlertScheduler } from '../src/services/alertScheduler';

const mockGetSetting = vi.mocked(getSetting);
const mockRunEval = vi.mocked(runAlertEvaluation);
const emptyResult = { alerts: [], newlyTriggered: [], positionAlerts: [], checkedAt: 0 };

afterEach(() => {
  stopAlertScheduler();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('alert scheduler loop lifecycle', () => {
  it('survives a throwing config read and re-arms (a DB hiccup must not kill the process or the loop)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    // Before the fix this rejection escaped loop() itself — an unhandled
    // rejection (process-fatal outside vitest) and a permanently dead poller.
    mockGetSetting.mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(1000); // initial arm → first tick, config read throws
    expect(errSpy).toHaveBeenCalledWith('[alert-scheduler]', 'disk I/O error');
    expect(vi.getTimerCount()).toBe(1); // still alive: re-armed on the fallback cadence

    // And once the DB recovers, the same loop picks the config back up.
    mockGetSetting.mockReturnValue({ enabled: true, intervalSeconds: 15 });
    mockRunEval.mockResolvedValue(emptyResult);
    await vi.advanceTimersByTimeAsync(30_000); // DISABLED_POLL_SECONDS fallback
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockRunEval).toHaveBeenCalled();
  });

  it('survives a rejecting tick and keeps polling on the configured cadence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    mockGetSetting.mockReturnValue({ enabled: true, intervalSeconds: 15 });
    mockRunEval.mockRejectedValue(new Error('provider down'));
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRunEval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000); // configured interval, not the disabled fallback
    expect(mockRunEval).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm when stopped while a tick is in flight (stop means stopped)', async () => {
    vi.useFakeTimers();
    mockGetSetting.mockReturnValue({ enabled: true, intervalSeconds: 15 });
    let resolveTick: (r: typeof emptyResult) => void = () => {};
    mockRunEval.mockImplementation(() => new Promise((resolve) => (resolveTick = resolve)));
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(1000); // loop is now awaiting the tick
    expect(vi.getTimerCount()).toBe(0); // in flight: no pending timer to clear…
    stopAlertScheduler(); // …so stop's clearTimeout alone couldn't stop it
    resolveTick(emptyResult);
    await vi.advanceTimersByTimeAsync(0); // let the loop finish past the await
    expect(vi.getTimerCount()).toBe(0); // fixed: the finished tick respected stop instead of re-arming
  });
});
