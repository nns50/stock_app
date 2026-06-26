import { describe, it, expect } from 'vitest';
import { isUsEquityMarketOpen, marketOpenContext } from '../src/services/trading/marketHours';

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
