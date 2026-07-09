import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, db } from '../src/db';
import { createPosition, getPosition } from '../src/db/positions';
import { config } from '../src/config';
import {
  getWebullSyncConfig,
  setWebullSyncConfig,
  runSchedulerTick,
  stopWebullPositionsSync,
  MIN_SYNC_INTERVAL_SECONDS,
} from '../src/services/webullPositionsScheduler';
import { priceMap } from '../src/services/quotes';

vi.mock('../src/services/quotes', () => ({ priceMap: vi.fn() }));

const origWebull = { ...config.webull };

beforeAll(() => initDb());
beforeEach(() => {
  stopWebullPositionsSync();
  db.exec("DELETE FROM settings WHERE key = 'webullPositionsScheduler'");
  db.exec('DELETE FROM position_exits; DELETE FROM positions;');
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
});
