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
  // ---------------------------------------------------------------------
  // THE PAYLOAD IS NOW THE RATCHET'S, AND THESE TESTS SAY WHY (2026-09-08).
  //
  // Everything this builder used to add beyond {clientOrderId, quantity} was a
  // guess at why the broker was refusing, and each guess shipped with a test
  // that asserted the guess rather than the outcome:
  //
  //   09-03  quantity only, one leg per request       9 refusals
  //   09-04  + the echoed defining price              refused
  //   09-04  + combo_type                             refused
  //   09-05  + order_type                             refused
  //   09-04+ both legs in one request, + combo id    46 refusals
  //
  // 148 refusals, 0 fills, and the tests were green for every one of them —
  // they asserted the request SHAPE, which was never the thing in doubt.
  //
  // Meanwhile webullReplaceOrder(id, { stopPrice }) — the stop ratchet — sends
  // the client order id and ONE field and has never failed: live_stop_adjust_failed
  // has never been journalled, and FCX ratcheted four times in four minutes on
  // 2026-09-08 inside a live combo group. That is the only shape this endpoint
  // is known to accept on a resting bracket leg, so the resize now copies it.
  // ---------------------------------------------------------------------
  it('sends the client order id and the new quantity, and NOTHING else', () => {
    const out = buildBracketResizePatches([tp(), sl()], 4);
    expect(out).toEqual([
      { clientOrderId: 'TGT-1', quantity: 4 },
      { clientOrderId: 'STOP-1', quantity: 4 },
    ]);
  });

  it('sends no combo_type and no order_type — both were refused hypotheses', () => {
    const out = buildBracketResizePatches([tp(), sl({ orderType: 'STOP_LOSS_LIMIT' })], 4);
    for (const patch of out!) {
      expect(patch).not.toHaveProperty('comboType');
      expect(patch).not.toHaveProperty('orderType');
    }
  });

  it('sends NO price, so a resize can never move a live stop', () => {
    // The old payload echoed the resting price back to "identify" the leg. That
    // put a protective price on the wire on every partial, for no benefit the
    // broker ever acknowledged — and a typo or a stale read would have moved a
    // real stop. The client order id identifies the leg; nothing else needs to.
    const out = buildBracketResizePatches([tp({ limitPrice: 110 }), sl({ stopPrice: 101.25 })], 3);
    for (const patch of out!) {
      expect(patch).not.toHaveProperty('limitPrice');
      expect(patch).not.toHaveProperty('stopPrice');
    }
  });

  it('still CLASSIFIES both legs even though it no longer sends the labels', () => {
    // The classification has not become decorative. It is what refuses a pair
    // that is not one take-profit and one stop — see the two tests below — so
    // dropping the labels from the wire must not drop the check.
    expect(buildBracketResizePatches([tp(), sl()], 4)).toHaveLength(2);
  });

  it('resizes a lone surviving leg — a filled target legitimately leaves one', () => {
    expect(buildBracketResizePatches([sl()], 2)).toEqual([{ clientOrderId: 'STOP-1', quantity: 2 }]);
    expect(buildBracketResizePatches([tp()], 2)).toEqual([{ clientOrderId: 'TGT-1', quantity: 2 }]);
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
