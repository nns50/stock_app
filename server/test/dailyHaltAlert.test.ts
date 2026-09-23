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

  // ONE LIVE HALT, ON THE FIGURE THE LIVE RISK CHECKS USE (2026-09-23).
  //
  // Both live risk checks compare stock PLUS options against the level
  // (liveExecute.ts adds the options seed; liveOptionsExecute.ts adds the stock
  // snapshot). This file used to judge the two sleeves separately, so a real
  // halt split across them pushed nothing, and options alone past the level on
  // a green stock day pushed a halt no check applied. The two cases below
  // replace the one that asserted exactly that split.
  it('alerts the LIVE pool on stock + options combined, and says which sleeve lost', async () => {
    // -1,800 + -1,300 = -3,100: past the -3,000 level, though neither sleeve is.
    mockDashboard.mockReturnValue(dash({ liveDailyPnl: -1_800, liveOptionsDailyPnl: -1_300 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [event] = mockDispatch.mock.calls[0][0];
    expect(event.title).toMatch(/LIVE\)/);
    expect(event.message).toMatch(/LIVE daily P&L \(\$-3,100\.00\) \(stock \$-1,800\.00, options \$-1,300\.00\)/);
    expect(event.message).toMatch(/new live entries are blocked/);
    const markers = alertMarkers();
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0].detail!)).toEqual({
      pool: 'live',
      date: '2026-08-03',
      dailyPnl: -3_100,
      haltLevel: -3_000,
      stockPnl: -1_800,
      optionsPnl: -1_300,
    });
  });

  it('does NOT alert when options alone cross the level but the live book as a whole has not', async () => {
    // -3,200 + 500 = -2,700: above the level. No live risk check halts here,
    // so neither may the alert.
    mockDashboard.mockReturnValue(dash({ liveDailyPnl: 500, liveOptionsDailyPnl: -3_200 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(alertMarkers()).toHaveLength(0);
  });

  it('alerts once per pool per day, not once total — both halted pools dispatch, once each', async () => {
    mockDashboard.mockReturnValue(dash({ dailyPnl: -3_100, liveDailyPnl: -3_100, liveOptionsDailyPnl: -3_100 }));
    expect(await maybeAlertDailyDrawdownHalt(ET_DAY_1)).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(alertMarkers()).toHaveLength(2);
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
