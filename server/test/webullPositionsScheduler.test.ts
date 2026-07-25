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
import { setSetting } from '../src/db/settings';
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
      'DELETE FROM order_intents; DELETE FROM position_exits; DELETE FROM positions; ' +
      'DELETE FROM webull_miss_streak;',
  );
  vi.mocked(priceMap).mockReset();
});
afterEach(() => {
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
});

describe('scheduler config', () => {
  it('defaults to enabled, 300s, no accounts', () => {
    expect(getWebullSyncConfig()).toEqual({ enabled: true, intervalSeconds: 300, accountIds: [] });
  });

  it('clamps the interval to the minimum', () => {
    const saved = setWebullSyncConfig({ intervalSeconds: 1 });
    expect(saved.intervalSeconds).toBe(MIN_SYNC_INTERVAL_SECONDS);
    expect(getWebullSyncConfig().intervalSeconds).toBe(MIN_SYNC_INTERVAL_SECONDS);
  });

  it('stores a list of accounts, trimmed and de-duplicated', () => {
    const saved = setWebullSyncConfig({ accountIds: [' CASH ', 'MARGIN', 'CASH', '  '] });
    expect(saved.accountIds).toEqual(['CASH', 'MARGIN']);
    expect(getWebullSyncConfig().accountIds).toEqual(['CASH', 'MARGIN']);
  });

  it('merges a partial patch (keeps unspecified fields)', () => {
    setWebullSyncConfig({ enabled: false, intervalSeconds: 600, accountIds: ['ACC1'] });
    const saved = setWebullSyncConfig({ intervalSeconds: 900 });
    expect(saved).toEqual({ enabled: false, intervalSeconds: 900, accountIds: ['ACC1'] });
  });

  it('accepts a legacy single accountId patch (back-compat) and stores it as a one-element list', () => {
    setWebullSyncConfig({ accountId: 'ACC1' });
    expect(getWebullSyncConfig().accountIds).toEqual(['ACC1']);
    setWebullSyncConfig({ accountId: null });
    expect(getWebullSyncConfig().accountIds).toEqual([]);
    setWebullSyncConfig({ accountId: '   ' });
    expect(getWebullSyncConfig().accountIds).toEqual([]);
  });

  it('migrates a persisted legacy single-accountId config to the accountIds list on read', () => {
    // Simulate a config saved before the multi-account change.
    setSetting('webullPositionsScheduler', { enabled: true, intervalSeconds: 300, accountId: 'LEGACY1' });
    expect(getWebullSyncConfig().accountIds).toEqual(['LEGACY1']);
  });
});

describe('runSchedulerTick', () => {
  it('no-ops when disabled', async () => {
    setWebullSyncConfig({ enabled: false, accountIds: ['ACC1'] });
    expect(await runSchedulerTick()).toBeNull();
  });

  it('no-ops when enabled but no account is configured yet', async () => {
    setWebullSyncConfig({ enabled: true, accountIds: [] });
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
    setWebullSyncConfig({ enabled: true, accountIds: ['ACC1'] });

    // First tick's miss isn't enough by itself — see webull_miss_streak's
    // table comment (db/index.ts) for the flapping-close bug this debounce
    // prevents; a real close is confirmed on the 2nd consecutive tick.
    await runSchedulerTick();
    const r = await runSchedulerTick();
    expect(r).toHaveLength(1);
    expect(r![0]).toMatchObject({ ok: true, accountId: 'ACC1', closed: 1, closedSymbols: ['VRAX'] });
    expect(getPosition(p.id)!.status).toBe('closed');
  });

  it('reconciles EVERY configured account in one tick — a cash AND a margin account (the reported multi-account bug)', async () => {
    // Each account holds a position that was sold at the broker; the sync must
    // close BOTH, not just whichever one happens to be first — the whole point
    // of the multi-account fix.
    const cash = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 33,
      entryPrice: 2.39,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'CASH',
    });
    const margin = createPosition({
      assetType: 'stock',
      symbol: 'SLND',
      side: 'long',
      quantity: 39,
      entryPrice: 1.08,
      entryDate: '2026-01-02',
      tags: ['webull'],
      accountId: 'MARGIN',
    });
    vi.mocked(priceMap).mockImplementation(
      async (positions) => new Map(positions.map((pos) => [pos.id, { price: 1, stale: false, asOf: 0 }])),
    );
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    // Both accounts' broker holdings come back empty -> both positions should close.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    } as Response);
    setWebullSyncConfig({ enabled: true, accountIds: ['CASH', 'MARGIN'] });

    await runSchedulerTick(); // first miss (per account) — not yet confirmed
    const r = await runSchedulerTick();
    expect(r).toHaveLength(2);
    expect(r!.map((x) => x.accountId).sort()).toEqual(['CASH', 'MARGIN']);
    expect(getPosition(cash.id)!.status).toBe('closed');
    expect(getPosition(margin.id)!.status).toBe('closed');
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
    setWebullSyncConfig({ enabled: true, accountIds: ['ACC1'] });

    const r = await runSchedulerTick();
    expect(r![0]).toMatchObject({ ok: true, ordersReconciled: 1, ordersChanged: 1 });
    const closed = listPositions().find((x) => x.id === pos.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.exits[0]).toMatchObject({ exitPrice: 1.75 });
  });
});
