import { describe, it, expect } from 'vitest';
import { normalizeWatchlist, withSymbol, withoutSymbol } from '../src/services/watchlist';

describe('normalizeWatchlist', () => {
  it('uppercases, trims, de-dupes, and drops junk', () => {
    expect(normalizeWatchlist([' aapl ', 'MSFT', 'aapl', 7, '', 'tsla'])).toEqual(['AAPL', 'MSFT', 'TSLA']);
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeWatchlist(undefined)).toEqual([]);
    expect(normalizeWatchlist('AAPL')).toEqual([]);
  });
});

describe('withSymbol / withoutSymbol', () => {
  it('adds case-insensitively without duplicating', () => {
    expect(withSymbol(['AAPL'], 'msft')).toEqual(['AAPL', 'MSFT']);
    expect(withSymbol(['AAPL'], 'aapl')).toEqual(['AAPL']);
    expect(withSymbol(['AAPL'], '  ')).toEqual(['AAPL']);
  });
  it('removes case-insensitively', () => {
    expect(withoutSymbol(['AAPL', 'MSFT'], 'aapl')).toEqual(['MSFT']);
    expect(withoutSymbol(['AAPL'], 'tsla')).toEqual(['AAPL']);
  });
});
