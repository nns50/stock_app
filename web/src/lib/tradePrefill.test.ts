import { describe, it, expect } from 'vitest';
import { contractToOrder, isPlaceableStructure, strategyToOrder } from './tradePrefill';
import type { OptionContract, StrategyLeg } from '../api/types';

const leg = (type: 'call' | 'put', action: 'buy' | 'sell', strike: number, premium: number): StrategyLeg => ({
  type,
  action,
  strike,
  quantity: 1,
  premium,
});

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

describe('isPlaceableStructure', () => {
  it('accepts a single leg and a 2-leg vertical', () => {
    expect(isPlaceableStructure([leg('call', 'buy', 100, 2)])).toBe(true);
    expect(isPlaceableStructure([leg('call', 'buy', 100, 2), leg('call', 'sell', 105, 1)])).toBe(true);
  });
  it('rejects straddles/strangles (mixed type), same-strike, same-side, and 3+ legs', () => {
    expect(isPlaceableStructure([leg('call', 'buy', 100, 2), leg('put', 'buy', 100, 2)])).toBe(false); // straddle
    expect(isPlaceableStructure([leg('call', 'buy', 100, 2), leg('call', 'sell', 100, 1)])).toBe(false); // same strike
    expect(isPlaceableStructure([leg('call', 'buy', 100, 2), leg('call', 'buy', 105, 1)])).toBe(false); // same side
    expect(
      isPlaceableStructure([leg('call', 'buy', 100, 2), leg('call', 'sell', 105, 1), leg('put', 'buy', 95, 1)]),
    ).toBe(false);
  });
});

describe('strategyToOrder', () => {
  it('maps a single leg to a single-leg order (no symbol/expiry — analyzer has none)', () => {
    expect(strategyToOrder([leg('put', 'sell', 95, 1.4)])).toMatchObject({
      symbol: '',
      assetKind: 'option',
      optionStrategy: 'SINGLE',
      side: 'sell',
      optionType: 'put',
      strike: 95,
      limitPrice: 1.4,
    });
  });
  it('maps a debit call spread to a VERTICAL buy with the net debit as the limit', () => {
    const o = strategyToOrder([leg('call', 'buy', 100, 2), leg('call', 'sell', 105, 1)]);
    expect(o).toMatchObject({ optionStrategy: 'VERTICAL', side: 'buy', limitPrice: 1 });
    expect(o.optionLegs).toEqual([
      { side: 'buy', optionType: 'call', strike: 100, expiration: '' },
      { side: 'sell', optionType: 'call', strike: 105, expiration: '' },
    ]);
  });
  it('maps a credit put spread to a VERTICAL sell with the net credit as the limit', () => {
    const o = strategyToOrder([leg('put', 'sell', 95, 2), leg('put', 'buy', 90, 1)]);
    expect(o).toMatchObject({ optionStrategy: 'VERTICAL', side: 'sell', limitPrice: 1 });
  });
});
