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
import {
  createLiveOptionsPosition,
  closeLiveOptionsPosition,
  CreateLiveOptionsPositionInput,
} from '../src/db/autotradeLiveOptionsPositions';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_options_orders; DELETE FROM autotrade_live_options_positions; ' +
      'DELETE FROM order_events; DELETE FROM order_intents;',
  );
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

function entryInput(intentId: number, overrides: Partial<Parameters<typeof recordLiveOptionsEntryOrder>[0]> = {}) {
  return {
    intentId,
    symbol: 'AAPL',
    kind: 'single_leg' as const,
    side: 'call' as const,
    contractSymbol: 'AAPL-fixture',
    strike: 100,
    expiration: '2030-01-18',
    riskAmount: 300,
    riskProfile: 'MODERATE',
    ...overrides,
  };
}

function newOpenPosition(overrides: Partial<CreateLiveOptionsPositionInput> = {}) {
  return createLiveOptionsPosition({
    symbol: 'AAPL',
    side: 'call',
    contractSymbol: 'AAPL-fixture',
    strike: 100,
    expiration: '2030-01-18',
    quantity: 2,
    entryPrice: 3.5,
    riskAmount: 700,
    riskProfile: 'MODERATE',
    rationale: 'test fixture',
    ...overrides,
  });
}

describe('autotradeLiveOptionsOrders', () => {
  it('records an entry order (with contract detail) and retrieves it', () => {
    const intentId = newIntentId('entry-1');
    const rec = recordLiveOptionsEntryOrder(entryInput(intentId, { riskAmount: 700 }));
    expect(rec).toMatchObject({
      intentId,
      symbol: 'AAPL',
      role: 'entry',
      kind: 'single_leg',
      side: 'call',
      contractSymbol: 'AAPL-fixture',
      strike: 100,
      shortContractSymbol: null,
      shortStrike: null,
      expiration: '2030-01-18',
      riskAmount: 700,
      riskProfile: 'MODERATE',
      positionId: null,
    });
    expect(getLiveOptionsOrder(intentId)).toEqual(rec);
  });

  it('records a debit-spread entry order carrying both legs', () => {
    const intentId = newIntentId('entry-spread-1');
    const rec = recordLiveOptionsEntryOrder(
      entryInput(intentId, { kind: 'debit_spread', shortContractSymbol: 'AAPL-short', shortStrike: 110 }),
    );
    expect(rec).toMatchObject({
      kind: 'debit_spread',
      contractSymbol: 'AAPL-fixture',
      strike: 100,
      shortContractSymbol: 'AAPL-short',
      shortStrike: 110,
    });
  });

  it('records an exit order with positionId known upfront, and null contract detail', () => {
    const intentId = newIntentId('exit-1');
    const rec = recordLiveOptionsExitOrder({
      intentId,
      symbol: 'AAPL',
      kind: 'debit_spread',
      riskProfile: 'MODERATE',
      positionId: 42,
    });
    expect(rec).toMatchObject({
      role: 'exit',
      kind: 'debit_spread',
      positionId: 42,
      riskAmount: null,
      contractSymbol: null,
      strike: null,
    });
  });

  it('setLiveOptionsOrderPositionId links an entry row to its materialized position', () => {
    const intentId = newIntentId('entry-2');
    recordLiveOptionsEntryOrder(entryInput(intentId));
    setLiveOptionsOrderPositionId(intentId, 7);
    expect(getLiveOptionsOrder(intentId)!.positionId).toBe(7);
  });

  describe('listPendingLiveOptionsOrders', () => {
    it('includes a non-terminal, not-yet-filled order', () => {
      const intentId = newIntentId('pending-1');
      recordLiveOptionsEntryOrder(entryInput(intentId));
      transitionIntent(intentId, 'validated');
      transitionIntent(intentId, 'confirmed');
      transitionIntent(intentId, 'submitted');
      transitionIntent(intentId, 'acknowledged');
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).toContain(intentId);
    });

    it('excludes a filled ENTRY whose position_id is already set (materialized successfully)', () => {
      const intentId = newIntentId('filled-materialized');
      recordLiveOptionsEntryOrder(entryInput(intentId));
      for (const state of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(intentId, state);
      }
      setLiveOptionsOrderPositionId(intentId, newOpenPosition().id);
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });

    it('KEEPS a filled ENTRY whose position_id is still null — materialization never ran or threw', () => {
      // Without this, a reconcile pass whose createLiveOptionsPosition() call
      // throws would silently and permanently drop the row: 'filled' intents
      // are otherwise excluded outright, so nothing would ever look at it
      // again. Mirrors autotradeLiveOrders.ts's own listPendingLiveOrders()
      // nuance for the same failure mode.
      const intentId = newIntentId('filled-unmaterialized');
      recordLiveOptionsEntryOrder(entryInput(intentId));
      for (const state of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(intentId, state);
      }
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).toContain(intentId);
    });

    it('excludes a filled EXIT whose referenced position is already closed', () => {
      const pos = newOpenPosition();
      closeLiveOptionsPosition(pos.id, { exitPrice: 1, exitReason: 'time_exit' });
      const intentId = newIntentId('filled-exit-closed');
      recordLiveOptionsExitOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskProfile: 'MODERATE',
        positionId: pos.id,
      });
      for (const state of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(intentId, state);
      }
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });

    it('KEEPS a filled EXIT whose referenced position is still open — close never materialized', () => {
      const pos = newOpenPosition();
      const intentId = newIntentId('filled-exit-open');
      recordLiveOptionsExitOrder({
        intentId,
        symbol: 'AAPL',
        kind: 'single_leg',
        riskProfile: 'MODERATE',
        positionId: pos.id,
      });
      for (const state of ['validated', 'confirmed', 'submitted', 'acknowledged', 'filled'] as const) {
        transitionIntent(intentId, state);
      }
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).toContain(intentId);
    });

    it('excludes a rejected order', () => {
      const intentId = newIntentId('terminal-rejected');
      recordLiveOptionsEntryOrder(entryInput(intentId));
      transitionIntent(intentId, 'rejected'); // draft -> rejected is a valid direct transition
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });

    it('excludes a cancelled order', () => {
      const intentId = newIntentId('terminal-cancelled');
      recordLiveOptionsEntryOrder(entryInput(intentId));
      for (const state of ['validated', 'confirmed', 'cancelled'] as const) transitionIntent(intentId, state);
      expect(listPendingLiveOptionsOrders().map((o) => o.intentId)).not.toContain(intentId);
    });
  });

  describe('countLiveOptionsOrdersSince', () => {
    it('counts entry-role orders placed at/after the cutoff', () => {
      const before = Date.now() - 10_000;
      const intentId = newIntentId('count-1');
      recordLiveOptionsEntryOrder(entryInput(intentId));
      expect(countLiveOptionsOrdersSince(before)).toBe(1);
      expect(countLiveOptionsOrdersSince(Date.now() + 10_000)).toBe(0);
    });

    it('does not count exit-role orders — an exit closes an already-counted trade, not a new one', () => {
      const before = Date.now() - 10_000;
      const entryIntentId = newIntentId('count-entry');
      const exitIntentId = newIntentId('count-exit');
      recordLiveOptionsEntryOrder(entryInput(entryIntentId));
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
      recordLiveOptionsEntryOrder(entryInput(rejectedId));
      transitionIntent(rejectedId, 'rejected');
      expect(countLiveOptionsOrdersSince(before)).toBe(0);
    });
  });
});
