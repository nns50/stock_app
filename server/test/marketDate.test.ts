import { describe, it, expect } from 'vitest';
import { etToday, etTimeOfDay, etDateTimeToMs } from '../src/util/marketDate';

// Fixed UTC instants with known America/New_York equivalents, covering both
// DST (EDT, UTC-4) and standard time (EST, UTC-5) so a TZ-naive regression
// can't pass by accident on a UTC CI box.
const EDT_AFTERNOON = Date.parse('2026-07-15T18:47:00Z'); // 14:47 ET (EDT)
const EDT_EVENING = Date.parse('2026-07-16T01:30:00Z'); // 21:30 ET on the 15th — next UTC day
const EST_MORNING = Date.parse('2026-01-15T14:31:00Z'); // 09:31 ET (EST)

describe('etTimeOfDay', () => {
  it('renders the ET wall clock, not the server (UTC) clock', () => {
    expect(etTimeOfDay(EDT_AFTERNOON)).toBe('14:47');
    expect(etTimeOfDay(EST_MORNING)).toBe('09:31');
  });

  it('crosses the UTC midnight boundary without drifting the time or the day', () => {
    expect(etTimeOfDay(EDT_EVENING)).toBe('21:30');
    expect(etToday(EDT_EVENING)).toBe('2026-07-15'); // still the 15th in ET
  });

  it('always produces the HH:MM shape positions.entry_time expects', () => {
    expect(etTimeOfDay()).toMatch(/^\d{2}:\d{2}$/);
    // Midnight ET must render as 00:xx, never the Intl "24:xx" quirk.
    const ET_MIDNIGHT = Date.parse('2026-07-15T04:00:00Z'); // 00:00 EDT
    expect(etTimeOfDay(ET_MIDNIGHT)).toBe('00:00');
  });
});

// etDateTimeToMs — the inverse, added 2026-08-25 so excursion.ts can bound an
// intraday holding period to the minutes actually held (positions store the
// entry as an ET date + HH:MM, which is not an instant until you resolve the
// offset — and the offset is the whole reason this file exists).
describe('etDateTimeToMs', () => {
  it('resolves an EDT wall-clock time to the right instant (UTC-4)', () => {
    expect(etDateTimeToMs('2026-08-24', '11:37')).toBe(Date.parse('2026-08-24T15:37:00Z'));
  });

  it('resolves an EST wall-clock time to the right instant (UTC-5)', () => {
    expect(etDateTimeToMs('2026-01-15', '09:30')).toBe(Date.parse('2026-01-15T14:30:00Z'));
  });

  it('round-trips against etToday/etTimeOfDay', () => {
    const ms = Date.parse('2026-08-24T17:09:00Z');
    expect(etDateTimeToMs(etToday(ms), etTimeOfDay(ms))).toBe(ms);
  });

  it('handles both sides of a DST boundary', () => {
    // US DST ends 2026-11-01. The day before is EDT, the day after EST.
    expect(etDateTimeToMs('2026-10-31', '12:00')).toBe(Date.parse('2026-10-31T16:00:00Z'));
    expect(etDateTimeToMs('2026-11-02', '12:00')).toBe(Date.parse('2026-11-02T17:00:00Z'));
  });

  it('accepts seconds, and rejects malformed input rather than guessing', () => {
    expect(etDateTimeToMs('2026-08-24', '11:37:30')).toBe(Date.parse('2026-08-24T15:37:30Z'));
    expect(etDateTimeToMs('not-a-date', '11:37')).toBeNull();
    expect(etDateTimeToMs('2026-08-24', '25:99x')).toBeNull();
    expect(etDateTimeToMs('2026-08-24', '')).toBeNull();
  });
});
