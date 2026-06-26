import { describe, it, expect } from 'vitest';
import { contractToOrder } from './tradePrefill';
import type { OptionContract } from '../api/types';

const base: OptionContract = {
  symbol: 'AMC260717C00007000',
  underlying: 'AMC',
  type: 'call',
  strike: 7,
  expiration: '2026-07-17',
};

describe('contractToOrder', () => {
  it('maps a contract to a single-leg buy with the mark as the limit price', () => {
    expect(contractToOrder({ ...base, mark: 1.23 })).toMatchObject({
      symbol: 'AMC',
      assetKind: 'option',
      optionStrategy: 'SINGLE',
      side: 'buy',
      openClose: 'open',
      quantity: 1,
      orderType: 'limit',
      optionType: 'call',
      strike: 7,
      expiration: '2026-07-17',
      limitPrice: 1.23,
    });
  });

  it('falls back to the bid/ask midpoint when there is no mark', () => {
    expect(contractToOrder({ ...base, bid: 1.0, ask: 1.5 }).limitPrice).toBe(1.25);
  });

  it('leaves the limit price undefined when there is no price at all', () => {
    expect(contractToOrder(base).limitPrice).toBeUndefined();
  });
});
