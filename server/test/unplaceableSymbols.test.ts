import { describe, it, expect, beforeEach } from 'vitest';
import {
  isUnparseableSymbolError,
  markUnplaceableSymbol,
  unplaceableReason,
  listUnplaceableSymbols,
  resetUnplaceableSymbols,
} from '../src/services/autotrading/unplaceableSymbols';

// The real message, captured from the live journal 2026-07-28.
const REAL = 'Parameter error, invalid market,symbol,instrument_type, value: US,BF.B,EQUITY';

beforeEach(() => resetUnplaceableSymbols());

describe('isUnparseableSymbolError', () => {
  it('recognises the broker refusing to parse THIS symbol', () => {
    expect(isUnparseableSymbolError('BF.B', REAL)).toBe(true);
    expect(isUnparseableSymbolError('bf.b', REAL)).toBe(true); // case-insensitive
  });

  it('does NOT fire for a different symbol named in the same message', () => {
    // The whole point of requiring the symbol to appear: a batch or a
    // mis-attributed error must not blocklist a tradable name.
    expect(isUnparseableSymbolError('AAPL', REAL)).toBe(false);
  });

  it('does NOT fire on a generic parameter error', () => {
    // "Parameter error" alone is far too broad — one malformed unrelated field
    // would permanently skip a perfectly good symbol.
    expect(isUnparseableSymbolError('AAPL', 'Parameter error, invalid quantity, value: -1')).toBe(false);
    expect(isUnparseableSymbolError('AAPL', 'Buying power is insufficient.')).toBe(false);
  });

  it('is safe on missing or empty input', () => {
    expect(isUnparseableSymbolError('AAPL', undefined)).toBe(false);
    expect(isUnparseableSymbolError('', REAL)).toBe(false);
  });
});

describe('the learned set', () => {
  it('records and reports a reason, normalised by case', () => {
    markUnplaceableSymbol('bf.b', REAL);
    expect(unplaceableReason('BF.B')).toBe(REAL);
    expect(listUnplaceableSymbols()).toEqual([{ symbol: 'BF.B', reason: REAL }]);
  });

  it('says nothing about a symbol it has never seen refused', () => {
    markUnplaceableSymbol('BF.B', REAL);
    expect(unplaceableReason('AAPL')).toBeUndefined();
  });
});
