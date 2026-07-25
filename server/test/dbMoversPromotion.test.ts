import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  recordMoverOccurrence,
  countRecentMoverOccurrences,
  isAutoPromoted,
  countAutoPromoted,
  recordAutoPromotion,
  listAutoPromotedSymbols,
} from '../src/db/moversPromotion';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM movers_occurrences');
  db.exec('DELETE FROM auto_promoted_symbols');
});

describe('movers occurrence tracking', () => {
  it('records an occurrence and is case-insensitive on symbol', () => {
    recordMoverOccurrence('aapl', '2026-07-01');
    expect(countRecentMoverOccurrences('AAPL', 10, new Date('2026-07-01T00:00:00Z'))).toBe(1);
  });

  it('is idempotent within the same calendar day (many ticks, one occurrence)', () => {
    recordMoverOccurrence('AAPL', '2026-07-01');
    recordMoverOccurrence('AAPL', '2026-07-01');
    recordMoverOccurrence('AAPL', '2026-07-01');
    expect(countRecentMoverOccurrences('AAPL', 10, new Date('2026-07-01T00:00:00Z'))).toBe(1);
  });

  it('counts a distinct occurrence for each distinct calendar day', () => {
    recordMoverOccurrence('AAPL', '2026-07-01');
    recordMoverOccurrence('AAPL', '2026-07-02');
    recordMoverOccurrence('AAPL', '2026-07-03');
    expect(countRecentMoverOccurrences('AAPL', 10, new Date('2026-07-03T00:00:00Z'))).toBe(3);
  });

  it('does not count occurrences outside the rolling window', () => {
    recordMoverOccurrence('AAPL', '2026-06-01'); // well outside a 10-day window from 07-10
    recordMoverOccurrence('AAPL', '2026-07-05');
    recordMoverOccurrence('AAPL', '2026-07-10');
    expect(countRecentMoverOccurrences('AAPL', 10, new Date('2026-07-10T00:00:00Z'))).toBe(2);
  });

  it('is inclusive of exactly windowDays ago (a 3-day window from day 3 includes day 1)', () => {
    recordMoverOccurrence('AAPL', '2026-07-01');
    expect(countRecentMoverOccurrences('AAPL', 3, new Date('2026-07-03T00:00:00Z'))).toBe(1);
  });

  it('excludes an occurrence one day older than the window', () => {
    recordMoverOccurrence('AAPL', '2026-06-30');
    expect(countRecentMoverOccurrences('AAPL', 3, new Date('2026-07-03T00:00:00Z'))).toBe(0);
  });

  it('tracks different symbols independently', () => {
    recordMoverOccurrence('AAPL', '2026-07-01');
    recordMoverOccurrence('MSFT', '2026-07-01');
    recordMoverOccurrence('MSFT', '2026-07-02');
    expect(countRecentMoverOccurrences('AAPL', 10, new Date('2026-07-02T00:00:00Z'))).toBe(1);
    expect(countRecentMoverOccurrences('MSFT', 10, new Date('2026-07-02T00:00:00Z'))).toBe(2);
  });

  it('defaults to zero occurrences for a symbol never recorded', () => {
    expect(countRecentMoverOccurrences('ZZZZ', 10)).toBe(0);
  });
});

describe('auto-promotion ledger', () => {
  it('is not auto-promoted until recorded', () => {
    expect(isAutoPromoted('AAPL')).toBe(false);
  });

  it('records a promotion and is case-insensitive', () => {
    recordAutoPromotion('aapl');
    expect(isAutoPromoted('AAPL')).toBe(true);
    expect(isAutoPromoted('aapl')).toBe(true);
  });

  it('is idempotent — recording the same symbol twice does not error or double-count', () => {
    recordAutoPromotion('AAPL');
    recordAutoPromotion('AAPL');
    expect(countAutoPromoted()).toBe(1);
  });

  it('counts multiple distinct promoted symbols', () => {
    recordAutoPromotion('AAPL');
    recordAutoPromotion('MSFT');
    recordAutoPromotion('NVDA');
    expect(countAutoPromoted()).toBe(3);
  });

  it('lists promoted symbols most-recent-first', () => {
    recordAutoPromotion('AAPL', 1000);
    recordAutoPromotion('MSFT', 2000);
    recordAutoPromotion('NVDA', 3000);
    expect(listAutoPromotedSymbols().map((r) => r.symbol)).toEqual(['NVDA', 'MSFT', 'AAPL']);
  });

  it('round-trips the promotedAt timestamp', () => {
    recordAutoPromotion('AAPL', 123456);
    const [row] = listAutoPromotedSymbols();
    expect(row).toEqual({ symbol: 'AAPL', promotedAt: 123456 });
  });
});
