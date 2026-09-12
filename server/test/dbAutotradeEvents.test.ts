import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  listAutotradeEvents,
  listAutotradeEventsInWindow,
  logAutotradeEvent,
  ROW_CAP,
} from '../src/db/autotradeEvents';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM autotrade_events'));

describe('autotrade journal', () => {
  it('appends an event and round-trips a JSON detail payload', () => {
    const rec = logAutotradeEvent({
      symbol: 'aapl',
      stage: 'screen',
      action: 'candidate_found',
      detail: { volume: 5_000_000, gapPct: 8.2 },
      riskProfile: 'MODERATE',
    });
    expect(rec.symbol).toBe('AAPL'); // uppercased
    expect(rec.detail).toBe(JSON.stringify({ volume: 5_000_000, gapPct: 8.2 }));
    expect(rec.riskProfile).toBe('MODERATE');
  });

  it('stores a string detail as-is (no double-encoding)', () => {
    const rec = logAutotradeEvent({ stage: 'config', action: 'enabled', detail: 'manual toggle' });
    expect(rec.detail).toBe('manual toggle');
  });

  it('allows a null symbol for non-symbol-scoped events', () => {
    const rec = logAutotradeEvent({ stage: 'config', action: 'risk_profile_changed' });
    expect(rec.symbol).toBeNull();
    expect(rec.detail).toBeNull();
  });

  it('lists newest-first', () => {
    logAutotradeEvent({ stage: 'screen', action: 'candidate_found', symbol: 'AAPL' });
    logAutotradeEvent({ stage: 'screen', action: 'candidate_found', symbol: 'MSFT' });
    const events = listAutotradeEvents();
    expect(events.map((e) => e.symbol)).toEqual(['MSFT', 'AAPL']);
  });

  it('filters by stage', () => {
    logAutotradeEvent({ stage: 'screen', action: 'candidate_found', symbol: 'AAPL' });
    logAutotradeEvent({ stage: 'risk_check', action: 'blocked_aggregate_risk', symbol: 'AAPL' });
    const events = listAutotradeEvents({ stage: 'risk_check' });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('blocked_aggregate_risk');
  });

  it('filters by symbol (case-insensitive)', () => {
    logAutotradeEvent({ stage: 'screen', action: 'candidate_found', symbol: 'AAPL' });
    logAutotradeEvent({ stage: 'screen', action: 'candidate_found', symbol: 'MSFT' });
    expect(listAutotradeEvents({ symbol: 'aapl' })).toHaveLength(1);
  });

  it('caps limit at 1000 and floors at 1', () => {
    logAutotradeEvent({ stage: 'screen', action: 'candidate_found' });
    expect(listAutotradeEvents({ limit: 0 })).toHaveLength(1); // floored to 1, still returns the one row
    expect(listAutotradeEvents({ limit: 5000 })).toHaveLength(1); // capped, but only 1 row exists
  });
});

// ---------------------------------------------------------------------------
// The windowed read (2026-09-12).
//
// listAutotradeEvents clamps to ROW_CAP whatever a caller asks for. That is
// right for a poll-path page and wrong for an analytic window, and the
// difference was invisible: the edge-leak scan asked for 1,000 skip rows over
// a window holding 1,928, got the newest 1,000 with no error, and classified
// every paper entry whose skip fell outside that set as "nothing the journal
// explains". The tune advisor then ranked 102 of them its top recommendation.
// ---------------------------------------------------------------------------
describe('listAutotradeEventsInWindow', () => {
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      logAutotradeEvent({ symbol: 'AAA', stage: 'execution', action: 'symbol_reentry_cooldown_skipped' });
    }
  };

  it('returns the WHOLE window where the capped read silently stops at ROW_CAP', () => {
    seed(ROW_CAP + 250);
    // The capped read cannot see past ROW_CAP even when asked for more — and
    // it does not say so, which is the part that cost a day.
    expect(listAutotradeEvents({ actions: ['symbol_reentry_cooldown_skipped'], limit: 99_999 })).toHaveLength(ROW_CAP);
    const windowed = listAutotradeEventsInWindow({ actions: ['symbol_reentry_cooldown_skipped'] });
    expect(windowed.events).toHaveLength(ROW_CAP + 250);
    expect(windowed.truncated).toBe(false);
  });

  it('reports truncation rather than quietly returning a short window', () => {
    seed(30);
    const windowed = listAutotradeEventsInWindow({ actions: ['symbol_reentry_cooldown_skipped'] }, 10);
    expect(windowed.events).toHaveLength(10);
    expect(windowed.truncated).toBe(true);
  });

  it('honours the same filters as the capped read, so the two cannot disagree', () => {
    logAutotradeEvent({ symbol: 'AAA', stage: 'execution', action: 'live_score_floor_skipped' });
    logAutotradeEvent({ symbol: 'BBB', stage: 'execution', action: 'live_score_floor_skipped' });
    logAutotradeEvent({ symbol: 'AAA', stage: 'screen', action: 'candidate_found' });
    const bySymbol = listAutotradeEventsInWindow({ symbol: 'aaa' }).events.map((e) => e.action);
    expect(bySymbol.sort()).toEqual(['candidate_found', 'live_score_floor_skipped']);
    expect(listAutotradeEventsInWindow({ actions: [] }).events).toEqual([]);
    expect(listAutotradeEventsInWindow({ stage: 'screen' }).events).toHaveLength(1);
  });
});
