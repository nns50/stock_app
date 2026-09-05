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
  comboOrderId: 'COMBO-1',
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
  comboOrderId: 'COMBO-1',
  orderType: 'STOP_LOSS',
  stopPrice: 96,
  quantity: 10,
  ...over,
});

describe('exitLegKind', () => {
  it('classifies a well-formed leg from either signal', () => {
    expect(exitLegKind(tp())).toBe('tp');
    expect(exitLegKind(sl())).toBe('sl');
  });

  // Both fields are documented. The Stock Orders reference gives them together:
  //   MASTER order_type LIMIT / BUY, STOP_PROFIT LIMIT / SELL, STOP_LOSS
  //   STOP_LOSS / SELL — and combo_type's enum is NORMAL / MASTER /
  //   STOP_PROFIT / STOP_LOSS / OTO / OCO / OTOCO.
  // order_type leads because its meaning is fixed by the order rather than by
  // its role in a group. It does NOT separate MASTER from STOP_PROFIT (both
  // LIMIT), so it is only safe here because the caller has already filtered to
  // the exit side and a long bracket's MASTER is a BUY.
  it('leads with order_type, whose meaning does not depend on group role', () => {
    expect(exitLegKind(tp({ comboType: undefined }))).toBe('tp');
    expect(exitLegKind(sl({ comboType: undefined }))).toBe('sl');
    expect(exitLegKind(sl({ comboType: undefined, orderType: 'STOP_LOSS_LIMIT' }))).toBe('sl');
    // An undocumented / normalised combo label does not override a clear type.
    expect(exitLegKind(tp({ comboType: 'OTOCO' }))).toBe('tp');
    expect(exitLegKind(sl({ comboType: 'OCO' }))).toBe('sl');
  });

  it('still uses combo_type when order_type is unreadable', () => {
    expect(exitLegKind(tp({ orderType: undefined }))).toBe('tp');
    expect(exitLegKind(sl({ orderType: undefined }))).toBe('sl');
  });

  it('believes NEITHER when the two disagree — a leg described inconsistently is not resized', () => {
    // The hazard this guards: trusting a mislabelled combo_type would send
    // stop_price for a limit order.
    expect(exitLegKind(tp({ comboType: 'STOP_LOSS' }))).toBeNull();
    expect(exitLegKind(sl({ comboType: 'STOP_PROFIT' }))).toBeNull();
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
    // combo_type names each leg's ROLE. Added 2026-09-04 after the
    // price-restating payload was also refused: the reference lists combo_type
    // as required on an order, and the broker's complaint is precisely that it
    // cannot tell the take-profit from the stop-loss.
    // order_type joins them from 2026-09-05: it is the field the REPLACE
    // endpoint's own schema documents (combo_type is not), and it is what tells
    // a LIMIT take-profit from a STOP_LOSS stop when both legs are `sell`.
    expect(out).toEqual([
      { clientOrderId: 'TGT-1', quantity: 4, limitPrice: 110, comboType: 'STOP_PROFIT', orderType: 'LIMIT' },
      { clientOrderId: 'STOP-1', quantity: 4, stopPrice: 96, comboType: 'STOP_LOSS', orderType: 'STOP_LOSS' },
    ]);
  });

  it('ECHOES order_type rather than deriving it from the leg role', () => {
    // A stop reported as STOP_LOSS_LIMIT must go back as STOP_LOSS_LIMIT.
    // Deriving 'STOP_LOSS' from "this is the stop leg" would convert a
    // stop-limit into a plain stop — changing a live protective order while
    // claiming only to identify it.
    const out = buildBracketResizePatches([sl({ orderType: 'STOP_LOSS_LIMIT' })], 3);
    expect(out![0]!.orderType).toBe('STOP_LOSS_LIMIT');
  });

  it('omits order_type when the broker reported none, rather than inventing one', () => {
    const out = buildBracketResizePatches([sl({ orderType: undefined })], 3);
    expect(out![0]).not.toHaveProperty('orderType');
    expect(out![0]!.comboType).toBe('STOP_LOSS'); // still classifiable by combo_type
  });

  it('echoes the price the broker reported — this identifies, it does not move a stop', () => {
    const out = buildBracketResizePatches([sl({ stopPrice: 101.25 })], 3);
    expect(out![0]!.stopPrice).toBe(101.25); // unchanged from what was read back
    expect(out![0]).not.toHaveProperty('limitPrice');
  });

  it('resizes a lone surviving leg — a filled target legitimately leaves one', () => {
    expect(buildBracketResizePatches([sl()], 2)).toEqual([
      { clientOrderId: 'STOP-1', quantity: 2, stopPrice: 96, comboType: 'STOP_LOSS', orderType: 'STOP_LOSS' },
    ]);
    expect(buildBracketResizePatches([tp()], 2)).toEqual([
      { clientOrderId: 'TGT-1', quantity: 2, limitPrice: 110, comboType: 'STOP_PROFIT', orderType: 'LIMIT' },
    ]);
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

  // restingExitOrders matches on symbol and side alone. A stale resting order on
  // the same symbol — a leftover from an earlier position, or a hand-placed one
  // — would otherwise be resized as if it were this bracket's take-profit.
  // A bracket is several envelopes sharing one combo_order_id.
  it('refuses two legs from DIFFERENT combo groups — that is not one bracket', () => {
    expect(buildBracketResizePatches([tp(), sl({ comboOrderId: 'COMBO-2' })], 4)).toBeNull();
  });

  it('still resizes when both legs share a group, or when the group id is unreadable', () => {
    expect(buildBracketResizePatches([tp(), sl()], 4)).toHaveLength(2);
    // Lenient parsing may not surface the id at all; that must not disable the
    // ordinary case, only a POSITIVE mismatch refuses.
    expect(
      buildBracketResizePatches([tp({ comboOrderId: undefined }), sl({ comboOrderId: undefined })], 4),
    ).toHaveLength(2);
    expect(buildBracketResizePatches([tp({ comboOrderId: undefined }), sl()], 4)).toHaveLength(2);
  });

  it('refuses a leg with no client order id — there is nothing to modify by', () => {
    expect(buildBracketResizePatches([tp(), sl({ clientOrderId: undefined })], 4)).toBeNull();
  });

  it('refuses zero legs and more than two', () => {
    expect(buildBracketResizePatches([], 4)).toBeNull();
    expect(buildBracketResizePatches([tp(), sl(), sl({ clientOrderId: 'STOP-2' })], 4)).toBeNull();
  });
});
