import { describe, it, expect } from 'vitest';
import { isUsEquityMarketOpen, isAfterSessionClose, marketOpenContext } from '../src/services/trading/marketHours';

// Fixed UTC instants → known ET wall-clock. June = EDT (UTC−4); January = EST (UTC−5).
const at = (iso: string) => new Date(iso);

describe('isUsEquityMarketOpen', () => {
  it('is open during regular hours on a weekday (EDT)', () => {
    expect(isUsEquityMarketOpen(at('2026-06-26T14:00:00Z'))).toBe(true); // Fri 10:00 ET
    expect(isUsEquityMarketOpen(at('2026-06-26T13:30:00Z'))).toBe(true); // 09:30 ET (open edge)
    expect(isUsEquityMarketOpen(at('2026-06-26T19:59:00Z'))).toBe(true); // 15:59 ET
  });

  it('is closed before the open, at/after the close, and overnight', () => {
    expect(isUsEquityMarketOpen(at('2026-06-26T13:29:00Z'))).toBe(false); // 09:29 ET
    expect(isUsEquityMarketOpen(at('2026-06-26T20:00:00Z'))).toBe(false); // 16:00 ET (close is exclusive)
    expect(isUsEquityMarketOpen(at('2026-06-26T02:53:00Z'))).toBe(false); // Thu 22:53 ET
  });

  it('is closed on weekends', () => {
    expect(isUsEquityMarketOpen(at('2026-06-27T14:00:00Z'))).toBe(false); // Sat 10:00 ET
    expect(isUsEquityMarketOpen(at('2026-06-28T14:00:00Z'))).toBe(false); // Sun 10:00 ET
  });

  it('handles the EST/EDT shift (winter)', () => {
    expect(isUsEquityMarketOpen(at('2026-01-09T14:30:00Z'))).toBe(true); // Fri 09:30 EST
    expect(isUsEquityMarketOpen(at('2026-01-09T14:00:00Z'))).toBe(false); // 09:00 EST
  });
});

describe('marketOpenContext', () => {
  const open = at('2026-06-26T14:00:00Z'); // Fri 10:00 ET (open)
  const closed = at('2026-06-26T02:53:00Z'); // Thu 22:53 ET (closed)

  it('applies to every option and to core-session stocks', () => {
    expect(marketOpenContext({ assetKind: 'option' }, closed)).toBe(false);
    expect(marketOpenContext({ assetKind: 'option' }, open)).toBe(true);
    expect(marketOpenContext({ assetKind: 'stock', session: 'core' }, closed)).toBe(false);
  });

  it('does not warn for explicitly off-hours stock sessions', () => {
    expect(marketOpenContext({ assetKind: 'stock', session: 'overnight' }, closed)).toBeUndefined();
    expect(marketOpenContext({ assetKind: 'stock', session: 'extended' }, closed)).toBeUndefined();
  });
});

describe('isAfterSessionClose', () => {
  // Not the negation of isUsEquityMarketOpen: anything that settles a trading
  // day once it is finished must not fire on a weekend, a holiday, or before
  // the open — none of which mean "today's session is over".
  it('is true only after the close on a trading day', () => {
    expect(isAfterSessionClose(at('2026-06-26T19:59:00Z'))).toBe(false); // Fri 15:59 ET
    expect(isAfterSessionClose(at('2026-06-26T20:00:00Z'))).toBe(true); // Fri 16:00 ET
    expect(isAfterSessionClose(at('2026-06-26T13:00:00Z'))).toBe(false); // Fri 09:00 ET, pre-open
  });

  it('honours an early close', () => {
    // 2026-11-27 closes at 13:00 ET.
    expect(isAfterSessionClose(at('2026-11-27T17:30:00Z'))).toBe(false); // 12:30 ET
    expect(isAfterSessionClose(at('2026-11-27T18:00:00Z'))).toBe(true); // 13:00 ET
  });

  it('is false on a weekend and on a holiday, at any hour', () => {
    expect(isAfterSessionClose(at('2026-06-27T22:00:00Z'))).toBe(false); // Sat 18:00 ET
    expect(isAfterSessionClose(at('2026-06-28T22:00:00Z'))).toBe(false); // Sun 18:00 ET
    expect(isAfterSessionClose(at('2026-01-01T22:00:00Z'))).toBe(false); // New Year's Day
  });

  it('accepts an epoch as well as a Date', () => {
    expect(isAfterSessionClose(Date.parse('2026-06-26T20:05:00Z'))).toBe(true);
  });
});
