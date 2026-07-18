import { describe, it, expect } from 'vitest';
import { sectorNotional } from '../src/services/autotrading/riskCheck';

const SECTORS: Record<string, string> = {
  CAND: 'Technology',
  EXIST: 'Technology',
  EXIST2: 'Technology',
  EXIST3: 'Technology',
  OTHER: 'Healthcare',
};
const sectorOf = (symbol: string) => SECTORS[symbol] ?? null;

describe('sectorNotional', () => {
  it('adds a same-sector position on the SAME side as the candidate', () => {
    const { amount, sector } = sectorNotional(
      'CAND',
      'long',
      [{ symbol: 'EXIST', notional: 1000, side: 'long' }],
      sectorOf,
    );
    expect(amount).toBe(1000);
    expect(sector).toBe('Technology');
  });

  it('nets (subtracts) a same-sector position on the OPPOSITE side — a hedge, not compounding risk', () => {
    const { amount } = sectorNotional(
      'CAND',
      'short', // candidate is short, existing same-sector position is long -> hedges it
      [{ symbol: 'EXIST', notional: 1000, side: 'long' }],
      sectorOf,
    );
    expect(amount).toBe(0); // fully offset, floored at 0 -- not -1000
  });

  it('floors net exposure at 0 rather than going negative when the hedge outweighs same-side exposure', () => {
    const { amount } = sectorNotional(
      'CAND',
      'long',
      [
        { symbol: 'EXIST', notional: 500, side: 'long' }, // +500 (same side)
        { symbol: 'EXIST2', notional: 2000, side: 'short' }, // -2000 (opposite side)
      ],
      sectorOf,
    );
    expect(amount).toBe(0); // 500 - 2000 = -1500, floored at 0
  });

  it('sums multiple same-side same-sector positions and nets an opposite-side one, net positive', () => {
    const { amount } = sectorNotional(
      'CAND',
      'long',
      [
        { symbol: 'EXIST', notional: 1000, side: 'long' }, // +1000
        { symbol: 'EXIST2', notional: 500, side: 'long' }, // +500
        { symbol: 'EXIST3', notional: 300, side: 'short' }, // -300
      ],
      sectorOf,
    );
    expect(amount).toBe(1200);
  });

  it('ignores a position in a DIFFERENT sector regardless of side', () => {
    const { amount } = sectorNotional('CAND', 'long', [{ symbol: 'OTHER', notional: 1000, side: 'short' }], sectorOf);
    expect(amount).toBe(0);
  });

  it('is a no-op with no positions at all', () => {
    const { amount, sector } = sectorNotional('CAND', 'long', [], sectorOf);
    expect(amount).toBe(0);
    expect(sector).toBe('Technology'); // the candidate's own sector is still reported
  });

  it('returns null sector and 0 amount when the candidate has no sector classification — nothing to compare it against', () => {
    const { amount, sector } = sectorNotional(
      'UNKNOWN',
      'long',
      [{ symbol: 'EXIST', notional: 1000, side: 'long' }],
      sectorOf,
    );
    expect(amount).toBe(0);
    expect(sector).toBeNull();
  });

  it('treats an "Unclassified" bucket the same as any other sector name (only null is special-cased)', () => {
    const unclassifiedOf = () => 'Unclassified';
    const { amount, sector } = sectorNotional(
      'CAND',
      'long',
      [{ symbol: 'EXIST', notional: 1000, side: 'long' }],
      unclassifiedOf,
    );
    expect(amount).toBe(1000);
    expect(sector).toBe('Unclassified');
  });
});
