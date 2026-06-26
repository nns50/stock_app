import type { OptionContract, OrderIntentInput } from '../api/types';

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
