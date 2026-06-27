import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import {
  createIntent,
  transitionIntent,
  getIntent,
  getEvents,
  listIntents,
  countTodaysOrders,
  isComboOrder,
} from '../src/db/orders';
import { IllegalTransitionError, OrderState } from '../src/services/trading/orderLifecycle';
import type { OrderIntent } from '../src/services/trading/guardrails';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM order_events; DELETE FROM order_intents;'));

const stockBuy: OrderIntent = {
  symbol: 'aapl',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 10,
  orderType: 'limit',
  limitPrice: 100,
};

describe('order intents persistence', () => {
  it('creates a draft intent and records a creation event', () => {
    const intent = createIntent(stockBuy, 'key-1');
    expect(intent).toMatchObject({ symbol: 'AAPL', state: 'draft', quantity: 10, orderType: 'limit', limitPrice: 100 });
    const events = getEvents(intent.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'draft', detail: 'created' });
  });

  it('persists the combo marker (strategy + bracket) so a replace can refuse spreads/brackets', () => {
    // Stock: no strategy, not a combo.
    const stock = createIntent(stockBuy, 'stk');
    expect(stock).toMatchObject({ optionStrategy: null, isBracket: false });
    expect(isComboOrder(stock)).toBe(false);

    // Bracketed stock: a combo (MASTER + exits).
    const braced = createIntent({ ...stockBuy, bracket: { takeProfitPrice: 110, stopLossPrice: 95 } }, 'brk');
    expect(braced).toMatchObject({ optionStrategy: null, isBracket: true });
    expect(isComboOrder(braced)).toBe(true);

    // Single-leg option: strategy defaults to SINGLE, modifiable in place.
    const single = createIntent(
      { ...stockBuy, assetKind: 'option', optionType: 'call', strike: 100, expiration: '2030-01-18' },
      'sgl',
    );
    expect(single).toMatchObject({ optionStrategy: 'SINGLE', isBracket: false });
    expect(isComboOrder(single)).toBe(false);

    // Vertical: a multi-leg combo.
    const vert = createIntent({ ...stockBuy, assetKind: 'option', optionStrategy: 'VERTICAL' }, 'vrt');
    expect(vert).toMatchObject({ optionStrategy: 'VERTICAL', isBracket: false });
    expect(isComboOrder(vert)).toBe(true);
  });

  it('treats an empty bracket object as not-a-bracket', () => {
    const rec = createIntent({ ...stockBuy, bracket: {} }, 'empty-bracket');
    expect(rec.isBracket).toBe(false);
    expect(isComboOrder(rec)).toBe(false);
  });

  it('is idempotent on the client key', () => {
    const a = createIntent(stockBuy, 'key-1');
    const b = createIntent({ ...stockBuy, quantity: 999 }, 'key-1'); // same key, different body
    expect(b.id).toBe(a.id);
    expect(b.quantity).toBe(10); // original wins; no duplicate row
    expect(listIntents()).toHaveLength(1);
  });

  it('walks a legal lifecycle and audits each step', () => {
    const intent = createIntent(stockBuy, 'key-1');
    transitionIntent(intent.id, 'validated');
    transitionIntent(intent.id, 'confirmed');
    const submitted = transitionIntent(intent.id, 'submitted', { brokerOrderId: 'WB123' });
    expect(submitted.state).toBe('submitted');
    expect(submitted.brokerOrderId).toBe('WB123');
    transitionIntent(intent.id, 'acknowledged');
    const filled = transitionIntent(intent.id, 'filled', { detail: 'fill @100' });
    expect(filled.state).toBe('filled');

    expect(getEvents(intent.id).map((e) => e.state)).toEqual([
      'draft',
      'validated',
      'confirmed',
      'submitted',
      'acknowledged',
      'filled',
    ]);
  });

  it('rejects an illegal transition and leaves state + audit untouched', () => {
    const intent = createIntent(stockBuy, 'key-1');
    expect(() => transitionIntent(intent.id, 'filled')).toThrow(IllegalTransitionError);
    expect(getIntent(intent.id)!.state).toBe('draft'); // unchanged
    expect(getEvents(intent.id)).toHaveLength(1); // no event appended for the failed jump
  });

  it('preserves an existing broker id when a later transition omits it', () => {
    const intent = createIntent(stockBuy, 'key-1');
    transitionIntent(intent.id, 'validated');
    transitionIntent(intent.id, 'confirmed');
    transitionIntent(intent.id, 'submitted', { brokerOrderId: 'WB123' });
    const acked = transitionIntent(intent.id, 'acknowledged'); // no brokerOrderId passed
    expect(acked.brokerOrderId).toBe('WB123'); // COALESCE keeps the prior value
  });

  it('filters intents by state', () => {
    const a = createIntent(stockBuy, 'k1');
    createIntent({ ...stockBuy }, 'k2');
    transitionIntent(a.id, 'validated');
    expect(listIntents({ state: 'validated' }).map((i) => i.id)).toEqual([a.id]);
    expect(listIntents({ state: 'draft' })).toHaveLength(1);
    expect(listIntents()).toHaveLength(2);
  });

  it('throws on transitioning a missing intent', () => {
    expect(() => transitionIntent(9999, 'validated')).toThrow(/No order intent/);
  });
});

describe('countTodaysOrders (the max-orders/day basis)', () => {
  // Create an intent and walk it through the given states (in order).
  const walk = (key: string, ...states: OrderState[]) => {
    const i = createIntent(stockBuy, key);
    for (const s of states) transitionIntent(i.id, s);
    return i.id;
  };

  it('counts orders that reached the broker today and were not rejected', () => {
    walk('filled', 'validated', 'confirmed', 'submitted', 'acknowledged', 'filled');
    walk('working', 'validated', 'confirmed', 'submitted'); // live, awaiting ack — still counts
    expect(countTodaysOrders()).toBe(2);
  });

  it('does NOT count broker-rejected orders (submitted → rejected)', () => {
    walk('ok', 'validated', 'confirmed', 'submitted', 'acknowledged', 'filled');
    walk('rej1', 'validated', 'confirmed', 'submitted', 'rejected');
    walk('rej2', 'validated', 'confirmed', 'submitted', 'rejected');
    expect(countTodaysOrders()).toBe(1); // only the filled order
  });

  it('does NOT count pre-submit rejections (never reached the broker)', () => {
    walk('preflight', 'validated', 'rejected');
    expect(countTodaysOrders()).toBe(0);
  });

  it("mirrors the user's day: one fill among a dozen rejections counts as one", () => {
    walk('fill', 'validated', 'confirmed', 'submitted', 'acknowledged', 'filled');
    for (let n = 0; n < 12; n++) walk(`r${n}`, 'validated', 'confirmed', 'submitted', 'rejected');
    expect(countTodaysOrders()).toBe(1);
  });
});
