import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));
vi.mock('../src/services/autotrading/dashboard', () => ({ getAutotradeDashboard: vi.fn() }));

import { initDb, db } from '../src/db';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { dispatchNotifications } from '../src/services/notifier';
import { getAutotradeDashboard, AutotradeDashboard } from '../src/services/autotrading/dashboard';
import { maybeAlertDailyDrawdownHalt } from '../src/services/autotrading/dailyHaltAlert';

const mockDispatch = vi.mocked(dispatchNotifications);
const mockDashboard = vi.mocked(getAutotradeDashboard);

// Only the four fields dailyHaltAlert.ts actually reads matter here — this
// intentionally does not re-test getAutotradeDashboard()'s own computation
// (see autotradeDashboard.test.ts for that); it unit-tests the alert/throttle
// logic in isolation, with a controllable, pre-computed dashboard snapshot.
function dash(overrides: Partial<AutotradeDashboard> = {}): AutotradeDashboard {
  return {
    equity: 100_000,
    dailyDrawdownHaltLevel: -3_000,
    dailyPnl: 0,
    liveDailyPnl: 0,
    liveOptionsDailyPnl: 0,
    ...overrides,
  } as AutotradeDashboard;
}

const alertMarkers = () => listAutotradeEvents({ actions: ['daily_halt_alerted'] });
const ET_DAY_1 = Date.parse('2026-08-03T15:00:00Z'); // a Monday, well inside market hours ET
const ET_DAY_2 = Date.parse('2026-08-04T15:00:00Z'); // the next day

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events');
  mockDispatch.mockClear();
  mockDashboard.mockReset();
});

describe('maybeAlertDailyDrawdownHalt', () => {
  it('does nothing when equity is unset (halt level is 0/-0, not a real cap)', async () => {
    mockDashboard.mockReturnValue(dash({ dailyDrawdownHaltLevel: 0, dailyPnl: -50 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does nothing when no pool has crossed its halt level', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -1_000, liveDailyPnl: -500, liveOptionsDailyPnl: 200 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(alertMarkers()).toHaveLength(0);
  });

  it('alerts for the paper pool once its daily P&L crosses the halt level', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_500 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const events = mockDispatch.mock.calls[0][0];
    expect(events[0].title).toMatch(/Paper/);
    // usd() formats a negative like riskCheck.ts's own helper does: "$-3,500.00", not "-$3,500.00".
    expect(events[0].message).toMatch(/Paper daily P&L \(\$-3,500\.00\) crossed the halt level \(\$-3,000\.00\)/);
    expect(events[0].message).toMatch(/new paper entries are blocked/);
    expect(alertMarkers()).toHaveLength(1);
  });

  it("treats exactly AT the halt level as halted, mirroring riskCheck.ts's own strict->not-halted comparison", async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_000 })); // === haltLevel, not just past it
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
  });

  it('alerts for live and live-options independently, each with its own label', async () => {
    mockDashboard.mockReturnValue(dash({ liveDailyPnl: -4_000, liveOptionsDailyPnl: -3_200 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    const titles = mockDispatch.mock.calls.map((c) => c[0][0].title);
    expect(titles).toEqual(
      expect.arrayContaining([expect.stringMatching(/LIVE\)/), expect.stringMatching(/LIVE options\)/)]),
    );
    expect(alertMarkers()).toHaveLength(2);
  });

  it('alerts once per pool per day, not once total — three halted pools dispatch three times', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_100, liveDailyPnl: -3_100, liveOptionsDailyPnl: -3_100 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(3);
    expect(alertMarkers()).toHaveLength(3);
  });

  it('does not re-alert the same pool again the same (ET) day', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_500 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
    mockDispatch.mockClear();
    // Still halted, later the same day — no second alert.
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1 + 60 * 60_000)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(alertMarkers()).toHaveLength(1);
  });

  it('re-alerts the next (ET) day if still halted — no cross-day carryover', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_500 }));
    await maybeAlertDailyDrawdownHalt(ET_DAY_1);
    mockDispatch.mockClear();
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_2)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(alertMarkers()).toHaveLength(2);
  });

  it('one pool alerting does not block a DIFFERENT pool from alerting the same day', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_500 }));
    await maybeAlertDailyDrawdownHalt(ET_DAY_1);
    mockDispatch.mockClear();
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_500, liveDailyPnl: -3_500 })); // paper still halted, live newly halted
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1 + 60_000)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1); // only the newly-halted pool (live)
    expect(mockDispatch.mock.calls[0][0][0].title).toMatch(/LIVE\)/);
  });
});
