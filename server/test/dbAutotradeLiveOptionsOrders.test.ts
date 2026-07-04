import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { createIntent, transitionIntent, OrderIntent } from '../src/db/orders';
import {
  countLiveOptionsOrdersSince,
  getLiveOptionsOrder,
  listPendingLiveOptionsOrders,
  recordLiveOptionsEntryOrder,
  recordLiveOptionsExitOrder,
  setLiveOptionsOrderPositionId,
} from '../src/db/autotradeLiveOptionsOrders';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM autotrade_live_options_orders; DELETE FROM order_events; DELETE FROM order_intents;');
});

const optionIntent: OrderIntent = {
  symbol: 'AAPL',
  assetKind: 'option',
  side: 'buy',
  openClose: 'open',
  quantity: 2,
  orderType: 'limit',
  limitPrice: 3.5,
  optionType: 'call',
  strike: 100,
  expiration: '2030-01-18',
};

function newIntentId(key: string): number {
  return createIntent(optionIntent, key).id;
}

describe('autotradeLiveOptionsOrders', () => {
  it('records an entry order and retrieves it', () => {
    const intentId = newIntentId('entry-1');
    const rec = recordLiveOptionsEntryOrder({
      intentId,
      symbol: 'AAPL',
      kind: 'single_leg',
      riskAmount: 700,
      riskProfile: 'MODERATE',
    });
    expect(rec).toMatchObject({
      intentId,
      symbol: 'AAPL',
      role: 'entry',
      kind: 'single_leg',
      riskAmount: 700,
      riskProfile: 'MODERATE',
      positionId: null,
    });
    expect(getLiveOptionsOrder(intentId)).toEqual(rec);
  });

  it('records an exit order with positionId known upfront, and null riskAmount', () => {
    const intentId = newIntentId('exit-1');
    const rec = recordLiveOptionsExitOrder({
      intentId,
      symbol: 'AAPL',
      kind: 'debit_spread',
      riskProfile: 'MODERATE',
      positionId: 42,
    });
    expect(rec).toMatchObject({ role: 'exit', kind: 'debit_spread', positionId: 42, riskAmount: null });
  });

  it('setLiveOptionsOrderPositionId links an entry row to its materialized position', () => {
    const intentId = newIntentId('entry-2');
    recordLiveOptionsEntryOrder({
      intentId,
      symbol: 'AAPL',
      kind: 'single_leg',
      riskAmount: 300,
      riskProfile: 'MODERATE',
    });
    setLiveOptionsOrderPositionId(intentId, 7);
    expect(getLiveOptionsOrder(intentId)!.positionId).toBe(7);
  });

  describe('listPendingLiveOptionsOrders', () => {
    it('includes a non-terminal, not-yet-filled order', () => {
      const intentId = newIntentId('pending-1');
      recordLiveOptionsEntryOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      transitionIntent(intentId, 'validated');
      transitionIntent(intentId, 'confirmed');
      transitionIntent(intentId, 'submitted');
      transitionIntent(intentId, 'acknowledged');
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).toContain(intentId);
    });

    it('excludes a filled order — no bracket child leg to keep watching for, unlike equity', () => {
      const intentId = newIntentId('filled-1');
      recordLiveOptionsEntryOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      for (const state of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(intentId, state);
      }
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });

    it('excludes a rejected order', () => {
      const intentId = newIntentId('terminal-rejected');
      recordLiveOptionsEntryOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      transitionIntent(intentId, 'rejected'); // draft -> rejected is a valid direct transition
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });

    it('excludes a cancelled order', () => {
      const intentId = newIntentId('terminal-cancelled');
      recordLiveOptionsEntryOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      for (const state of ['validated', 'confirmed', 'cancelled'] as const) transitionIntent(intentId, state);
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });
  });

  describe('countLiveOptionsOrdersSince', () => {
    it('counts entry-role orders placed at/after the cutoff', () => {
      const before = Date.now() - 10_000;
      const intentId = newIntentId('count-1');
      recordLiveOptionsEntryOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      expect(countLiveOptionsOrdersSince(before)).toBe(1);
      expect(countLiveOptionsOrdersSince(Date.now() + 10_000)).toBe(0);
    });

    it('does not count exit-role orders — an exit closes an already-counted trade, not a new one', () => {
      const before = Date.now() - 10_000;
      const entryIntentId = newIntentId('count-entry');
      const exitIntentId = newIntentId('count-exit');
      recordLiveOptionsEntryOrder({
        intentId: entryIntentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      recordLiveOptionsExitOrder({
        intentId: exitIntentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskProfile: 'MODERATE',
        positionId: 1,
      });
      expect(countLiveOptionsOrdersSince(before)).toBe(1);
    });

    it('excludes rejected/cancelled/expired entries — never became a real trade', () => {
      const before = Date.now() - 10_000;
      const rejectedId = newIntentId('count-rejected');
      recordLiveOptionsEntryOrder({
        intentId: rejectedId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskAmount: 300,
        riskProfile: 'MODERATE',
      });
      transitionIntent(rejectedId, 'rejected');
      expect(countLiveOptionsOrdersSince(before)).toBe(0);
    });
  });
});
