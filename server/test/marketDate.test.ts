import { describe, it, expect } from 'vitest';
import { etToday, etTimeOfDay } from '../src/util/marketDate';

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
