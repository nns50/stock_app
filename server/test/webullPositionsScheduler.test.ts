import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, getPosition, listPositions } from '../src/db/positions';
import { createIntent, transitionIntent } from '../src/db/orders';
import { config } from '../src/config';
import {
  getWebullSyncConfig,
  setWebullSyncConfig,
  runSchedulerTick,
  stopWebullPositionsSync,
  MIN_SYNC_INTERVAL_SECONDS,
} from '../src/services/webullPositionsScheduler';
import { priceMap } from '../src/services/quotes';
import type { OrderIntent } from '../src/services/trading/guardrails';

vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));

const origWebull = { ...config.webull };
const okResp = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as Response;

beforeAll(() => initDb());
beforeEach(() => {
  stopWebullPositionsSync();
  db.exec("DELETE FROM settings WHERE key = 'webullPositionsScheduler'");
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; DELETE FROM order_events; ' +
      'DELETE FROM order_intents; DELETE FROM position_exits; DELETE FROM positions;',
  );
  vi.mocked(priceMap).mockReset();
});
afterEach(() => {
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
});

describe('scheduler config', () => {
  it('defaults to enabled, 300s, no account id', () => {
    expect(getWebullSyncConfig()).toEqual({ enabled: true, intervalSeconds: 300, accountId: null });
  });

  it('clamps the interval to the minimum', () => {
    const saved = setWebullSyncConfig({ intervalSeconds: 1 });
    expect(saved.intervalSeconds).toBe(MIN_SYNC_INTERVAL_SECONDS);
    expect(getWebullSyncConfig().intervalSeconds).toBe(MIN_SYNC_INTERVAL_SECONDS);
  });

  it('merges a partial patch (keeps unspecified fields)', () => {
    setWebullSyncConfig({ enabled: false, intervalSeconds: 600, accountId: 'ACC1' });
    const saved = setWebullSyncConfig({ intervalSeconds: 900 });
    expect(saved).toEqual({ enabled: false, intervalSeconds: 900, accountId: 'ACC1' });
  });

  it('accepts and clears an account id', () => {
    setWebullSyncConfig({ accountId: 'ACC1' });
    expect(getWebullSyncConfig().accountId).toBe('ACC1');
    setWebullSyncConfig({ accountId: null });
    expect(getWebullSyncConfig().accountId).toBeNull();
  });

  it('treats a blank account id as unset', () => {
    setWebullSyncConfig({ accountId: '   ' });
    expect(getWebullSyncConfig().accountId).toBeNull();
  });
});

describe('runSchedulerTick', () => {
  it('no-ops when disabled', async () => {
    setWebullSyncConfig({ enabled: false, accountId: 'ACC1' });
    expect(await runSchedulerTick()).toBeNull();
  });

  it('no-ops when enabled but no account id is configured yet', async () => {
    setWebullSyncConfig({ enabled: true, accountId: null });
    expect(await runSchedulerTick()).toBeNull();
  });

  it('runs a real close+import pass against the configured account id when enabled', async () => {
    const p = createPosition({
      assetType: 'stock',
      symbol: 'VRAX',
      side: 'long',
      quantity: 10,
      entryPrice: 20,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'ACC1',
    });
    vi.mocked(priceMap).mockResolvedValue(new Map([[p.id, { price: 15, stale: false, asOf: 0 }]]));
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]), // Webull shows nothing held -> VRAX should close
    } as Response);
    setWebullSyncConfig({ enabled: true, accountId: 'ACC1' });

    const r = await runSchedulerTick();
    expect(r).toMatchObject({ ok: true, accountId: 'ACC1', closed: 1, closedSymbols: ['VRAX'] });
    expect(getPosition(p.id)!.status).toBe('closed');
  });

  it('also reconciles a working order in the same tick — a filled bracket exit leg', async () => {
    const CID = 'sched-bracket-cid';
    const rec = createIntent(
      {
        symbol: 'AMC',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 1.89,
        referencePrice: 1.89,
        bracket: { takeProfitPrice: 2.5, stopLossPrice: 1.5 },
      } as OrderIntent,
      CID,
    );
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'MASTER-1' });
    transitionIntent(rec.id, 'filled', { detail: 'entry filled' });
    const pos = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 1,
      entryPrice: 1.89,
      entryDate: '2026-06-01',
      sourceIntentId: rec.id,
    });

    const bracketStopFilledEnvelope = {
      client_order_id: CID,
      combo_order_id: 'MASTER-1',
      orders: [
        {
          combo_type: 'MASTER',
          status: 'FILLED',
          client_order_id: CID,
          order_id: 'MASTER-1',
          filled_quantity: '1',
          filled_price: '1.89',
        },
        { combo_type: 'STOP_LOSS', status: 'FILLED', order_id: 'SL-1', filled_quantity: '1', filled_price: '1.75' },
        { combo_type: 'STOP_PROFIT', status: 'CANCELLED', order_id: 'TP-1' },
      ],
    };
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([bracketStopFilledEnvelope])) // reconcileAllWorking: open orders, matches
      .mockResolvedValueOnce(okResp([])); // position-truth sync: nothing else to close/import
    setWebullSyncConfig({ enabled: true, accountId: 'ACC1' });

    const r = await runSchedulerTick();
    expect(r).toMatchObject({ ok: true, ordersReconciled: 1, ordersChanged: 1 });
    const closed = listPositions().find((x) => x.id === pos.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.exits[0]).toMatchObject({ exitPrice: 1.75 });
  });
});
