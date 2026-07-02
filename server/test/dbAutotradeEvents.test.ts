import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { listAutotradeEvents, logAutotradeEvent } from '../src/db/autotradeEvents';

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
