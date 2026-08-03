import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../src/services/notifier', () => ({
  dispatchNotifications: vi.fn().mockResolvedValue({ delivered: true, count: 1, results: [] }),
}));
// Pin the market OPEN by default: these tests run at whatever wall-clock CI
// happens to be at, and the re-alert path is now gated on market hours. The
// closed-market cases flip this mock explicitly.
vi.mock('../src/services/trading/marketHours', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/trading/marketHours')>()),
  isUsEquityMarketOpen: vi.fn(() => true),
}));

import { initDb, db } from '../src/db';
import { logAutotradeEvent, listAutotradeEvents } from '../src/db/autotradeEvents';
import { dispatchNotifications } from '../src/services/notifier';
import { isUsEquityMarketOpen } from '../src/services/trading/marketHours';
import {
  maybeAlertLiveOrderFailures,
  maybeAlertLiveAmbiguity,
  AMBIGUITY_ACTIONS,
  FAILURE_ACTIONS,
  LIVE_FAILURE_ALERT_THRESHOLD,
  LIVE_FAILURE_REALERT_COOLDOWN_MS,
  LIVE_AMBIGUITY_REALERT_COOLDOWN_MS,
} from '../src/services/autotrading/liveFailureAlert';

const mockDispatch = vi.mocked(dispatchNotifications);
const mockMarketOpen = vi.mocked(isUsEquityMarketOpen);

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_events');
  mockDispatch.mockClear();
  mockMarketOpen.mockReturnValue(true);
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

  it('suppresses RE-alerts while the market is closed — a stale streak cannot change out of session', async () => {
    // Observed in practice: a Friday streak re-alerted hourly all weekend (~40
    // identical pages) although nothing could place, grow, or resolve it.
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    await maybeAlertLiveOrderFailures();
    const marker = alertMarkers()[0];
    mockDispatch.mockClear();

    mockMarketOpen.mockReturnValue(false);
    const afterCooldown = marker.createdAt + LIVE_FAILURE_REALERT_COOLDOWN_MS + 1000;
    expect(await maybeAlertLiveOrderFailures(afterCooldown)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(alertMarkers()).toHaveLength(1); // no marker either — nothing happened
  });

  it('still fires the FIRST alert of a streak while the market is closed', async () => {
    // An out-of-session failure (e.g. a time-exit close attempt) is NEW
    // information — only repetition is gated, never the first report.
    mockMarketOpen.mockReturnValue(false);
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    expect(await maybeAlertLiveOrderFailures()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('delivers the held-back reminder once the market reopens', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD);
    await maybeAlertLiveOrderFailures();
    const marker = alertMarkers()[0];
    mockDispatch.mockClear();

    const afterCooldown = marker.createdAt + LIVE_FAILURE_REALERT_COOLDOWN_MS + 1000;
    mockMarketOpen.mockReturnValue(false);
    expect(await maybeAlertLiveOrderFailures(afterCooldown)).toBe(false); // weekend: quiet

    mockMarketOpen.mockReturnValue(true);
    expect(await maybeAlertLiveOrderFailures(afterCooldown + 60_000)).toBe(true); // open: reminds once
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

  it('does not count an AMBIGUITY event as a rejection (they are separate alerts)', async () => {
    for (let i = 0; i < LIVE_FAILURE_ALERT_THRESHOLD + 2; i++) {
      logAutotradeEvent({
        symbol: 'X',
        stage: 'execution',
        action: 'live_order_outcome_unknown',
        detail: { reason: 'timed out' },
      });
    }
    expect(await maybeAlertLiveOrderFailures()).toBe(false);
  });
});

function ambiguous(action = 'live_order_outcome_unknown', symbol = 'NVDA', reason = 'Request timed out after 10000ms') {
  logAutotradeEvent({ symbol, stage: 'execution', action, detail: { reason } });
}
const ambiguityMarkers = () => listAutotradeEvents({ actions: ['live_ambiguity_alerted'] });

describe('maybeAlertLiveAmbiguity', () => {
  it('does not alert when nothing is unresolved', async () => {
    expect(await maybeAlertLiveAmbiguity()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('alerts on the FIRST unresolved order — one is already real exposure', async () => {
    ambiguous();
    expect(await maybeAlertLiveAmbiguity()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const events = mockDispatch.mock.calls[0][0];
    expect(events[0].message).toMatch(/1 live order in an UNRESOLVED state/);
    expect(events[0].message).toMatch(/NVDA/);
    expect(events[0].message).toMatch(/never answered/);
    expect(ambiguityMarkers()).toHaveLength(1);
  });

  it('covers every ambiguity action, each with its own summary line', async () => {
    for (const action of AMBIGUITY_ACTIONS) {
      db.exec('DELETE FROM autotrade_events');
      mockDispatch.mockClear();
      ambiguous(action);
      expect(await maybeAlertLiveAmbiguity(), `${action} should alert`).toBe(true);
      const message = mockDispatch.mock.calls[0][0][0].message;
      // Never the generic fallback — every action names what actually happened.
      expect(message, `${action} needs a summary line`).not.toMatch(/could not be resolved/);
    }
  });

  it('a later SUCCESS does not clear an unresolved fill (unlike the rejection streak)', async () => {
    ambiguous('live_fill_not_fully_materialized');
    placed(); // a real order gets through afterwards...
    // ...which says nothing about the shares the ledger still hasn't booked.
    expect(await maybeAlertLiveAmbiguity()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('does not re-report what an earlier alert already covered', async () => {
    ambiguous();
    expect(await maybeAlertLiveAmbiguity()).toBe(true);
    mockDispatch.mockClear();
    // No NEW ambiguity since the marker — nothing to say, even long after the
    // cooldown has elapsed.
    const marker = ambiguityMarkers()[0];
    expect(await maybeAlertLiveAmbiguity(marker.createdAt + LIVE_AMBIGUITY_REALERT_COOLDOWN_MS + 1000)).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(ambiguityMarkers()).toHaveLength(1);
  });

  it('throttles a fresh ambiguity within the cooldown, then reports it after', async () => {
    ambiguous();
    await maybeAlertLiveAmbiguity();
    const marker = ambiguityMarkers()[0];
    mockDispatch.mockClear();
    ambiguous('live_exit_ambiguous', 'AAPL');
    expect(await maybeAlertLiveAmbiguity(marker.createdAt + 60_000)).toBe(false);
    expect(await maybeAlertLiveAmbiguity(marker.createdAt + LIVE_AMBIGUITY_REALERT_COOLDOWN_MS + 1000)).toBe(true);
    expect(mockDispatch.mock.calls[0][0][0].message).toMatch(/AAPL/);
    expect(ambiguityMarkers()).toHaveLength(2);
  });

  it('counts several unresolved orders in one report', async () => {
    ambiguous('live_order_outcome_unknown', 'A');
    ambiguous('live_options_materialization_failed', 'B');
    ambiguous('live_exit_ambiguous', 'C');
    expect(await maybeAlertLiveAmbiguity()).toBe(true);
    expect(mockDispatch.mock.calls[0][0][0].message).toMatch(/3 live orders in an UNRESOLVED state/);
  });

  it('ignores plain rejections — those are the other alert', async () => {
    failN(LIVE_FAILURE_ALERT_THRESHOLD + 2);
    expect(await maybeAlertLiveAmbiguity()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('the two action sets are disjoint, so no event is reported by both alerts', () => {
    const overlap = AMBIGUITY_ACTIONS.filter((a) => FAILURE_ACTIONS.includes(a));
    expect(overlap).toEqual([]);
  });
});
