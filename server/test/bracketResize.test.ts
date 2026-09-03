import { describe, it, expect } from 'vitest';
import { buildBracketResizePatches, exitLegKind, type WebullOpenOrder } from '../src/providers/webull/orders';

// Both legs of a LONG bracket are `sell`, so side cannot tell them apart. What
// can: combo_type (STOP_PROFIT / STOP_LOSS, carried on the envelope of a real
// /order/open response) and order_type (LIMIT / STOP_LOSS, how bracketExit
// places them).
const tp = (over: Partial<WebullOpenOrder> = {}): WebullOpenOrder => ({
  clientOrderId: 'TGT-1',
  symbol: 'AAPL',
  side: 'sell',
  status: 'OPEN',
  comboType: 'STOP_PROFIT',
  orderType: 'LIMIT',
  limitPrice: 110,
  quantity: 10,
  ...over,
});
const sl = (over: Partial<WebullOpenOrder> = {}): WebullOpenOrder => ({
  clientOrderId: 'STOP-1',
  symbol: 'AAPL',
  side: 'sell',
  status: 'OPEN',
  comboType: 'STOP_LOSS',
  orderType: 'STOP_LOSS',
  stopPrice: 96,
  quantity: 10,
  ...over,
});

describe('exitLegKind', () => {
  it('prefers combo_type, which is what the broker actually labels the leg with', () => {
    expect(exitLegKind(tp())).toBe('tp');
    expect(exitLegKind(sl())).toBe('sl');
  });

  it('falls back to order_type when combo_type is absent', () => {
    expect(exitLegKind(tp({ comboType: undefined }))).toBe('tp');
    expect(exitLegKind(sl({ comboType: undefined }))).toBe('sl');
    expect(exitLegKind(sl({ comboType: undefined, orderType: 'STOP_LOSS_LIMIT' }))).toBe('sl');
  });

  it('is null when neither says anything — never guesses a leg it cannot read', () => {
    expect(exitLegKind(tp({ comboType: undefined, orderType: undefined }))).toBeNull();
    expect(exitLegKind(sl({ comboType: 'MASTER', orderType: undefined }))).toBeNull();
  });
});

describe('buildBracketResizePatches', () => {
  // The bug this exists for: a quantity-only modify names nothing that
  // identifies either leg, and the broker refuses the pair with "The number of
  // take-profit orders and the number of stop-loss orders must be the same" —
  // 9 refusals on 2026-09-03, on the first day the stop ratchet worked. The
  // ratchet's own single-leg modify carries stop_price and was accepted 6/6.
  it('restates each leg’s DEFINING price alongside the new quantity', () => {
    const out = buildBracketResizePatches([tp(), sl()], 4);
    expect(out).toEqual([
      { clientOrderId: 'TGT-1', quantity: 4, limitPrice: 110 },
      { clientOrderId: 'STOP-1', quantity: 4, stopPrice: 96 },
    ]);
  });

  it('echoes the price the broker reported — this identifies, it does not move a stop', () => {
    const out = buildBracketResizePatches([sl({ stopPrice: 101.25 })], 3);
    expect(out![0]!.stopPrice).toBe(101.25); // unchanged from what was read back
    expect(out![0]).not.toHaveProperty('limitPrice');
  });

  it('resizes a lone surviving leg — a filled target legitimately leaves one', () => {
    expect(buildBracketResizePatches([sl()], 2)).toEqual([{ clientOrderId: 'STOP-1', quantity: 2, stopPrice: 96 }]);
    expect(buildBracketResizePatches([tp()], 2)).toEqual([{ clientOrderId: 'TGT-1', quantity: 2, limitPrice: 110 }]);
  });

  it('refuses a pair that is not one of each — two stops is not a bracket', () => {
    expect(buildBracketResizePatches([sl({ clientOrderId: 'STOP-1' }), sl({ clientOrderId: 'STOP-2' })], 4)).toBeNull();
    expect(buildBracketResizePatches([tp({ clientOrderId: 'T1' }), tp({ clientOrderId: 'T2' })], 4)).toBeNull();
  });

  it('refuses legs it cannot classify rather than sending the payload that gets rejected', () => {
    const blind = [
      { clientOrderId: 'A', side: 'sell' as const },
      { clientOrderId: 'B', side: 'sell' as const },
    ];
    expect(buildBracketResizePatches(blind, 4)).toBeNull();
  });

  it('refuses a leg with no client order id — there is nothing to modify by', () => {
    expect(buildBracketResizePatches([tp(), sl({ clientOrderId: undefined })], 4)).toBeNull();
  });

  it('refuses zero legs and more than two', () => {
    expect(buildBracketResizePatches([], 4)).toBeNull();
    expect(buildBracketResizePatches([tp(), sl(), sl({ clientOrderId: 'STOP-2' })], 4)).toBeNull();
  });
});
