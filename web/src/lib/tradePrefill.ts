import type { OptionContract, OrderIntentInput, StrategyLeg } from '../api/types';

// Maps an Options-page selection into a Trade-builder order, passed via router
// navigation state (see TradePage). Keeps the "Trade it" handoff in one tested
// place. Chain → single-leg here; the analyzer → structure mapper lives alongside
// it when that handoff lands.

/** A single option contract (from the live chain) → a single-leg BUY order
 *  prefill, carrying the mark (or bid/ask midpoint) in as the limit price. */
export function contractToOrder(c: OptionContract): OrderIntentInput {
  const mid = c.bid !== undefined && c.ask !== undefined ? (c.bid + c.ask) / 2 : undefined;
  const px = c.mark ?? mid;
  return {
    symbol: c.underlying,
    assetKind: 'option',
    optionStrategy: 'SINGLE',
    side: 'buy',
    openClose: 'open',
    quantity: 1,
    orderType: 'limit',
    optionType: c.type,
    strike: c.strike,
    expiration: c.expiration,
    limitPrice: px !== undefined ? Math.round(px * 100) / 100 : undefined,
  };
}

/** Whether analyzer legs map to something the Trade builder can place today: a
 *  single leg, or a 2-leg vertical (same type, one buy + one sell, distinct
 *  strikes). Straddles/strangles/condors aren't placeable yet. */
export function isPlaceableStructure(legs: StrategyLeg[]): boolean {
  if (legs.length === 1) return true;
  if (legs.length === 2) {
    const [a, b] = legs;
    return a.type === b.type && a.action !== b.action && a.strike !== b.strike;
  }
  return false;
}

/** Analyzer legs → an order prefill (structure only — the analyzer has no symbol
 *  or expiry, so those are left blank for you to set). Assumes the structure is
 *  placeable; net premium decides debit (buy) vs credit (sell) for a spread. */
export function strategyToOrder(legs: StrategyLeg[]): OrderIntentInput {
  const base = {
    symbol: '',
    assetKind: 'option' as const,
    side: 'buy' as const,
    openClose: 'open' as const,
    quantity: legs[0]?.quantity ?? 1,
    orderType: 'limit' as const,
  };
  if (legs.length === 1) {
    const l = legs[0];
    return {
      ...base,
      optionStrategy: 'SINGLE',
      side: l.action,
      optionType: l.type,
      strike: l.strike,
      limitPrice: l.premium,
    };
  }
  const net = legs.reduce((s, l) => s + (l.action === 'buy' ? l.premium : -l.premium), 0);
  return {
    ...base,
    optionStrategy: 'VERTICAL',
    side: net >= 0 ? 'buy' : 'sell', // net debit ⇒ buy, net credit ⇒ sell
    limitPrice: Math.round(Math.abs(net) * 100) / 100,
    optionLegs: legs.map((l) => ({ side: l.action, optionType: l.type, strike: l.strike, expiration: '' })),
  };
}
