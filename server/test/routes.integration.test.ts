import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { db } from '../src/db';

// End-to-end tests through the real Express app → routers → services → SQLite
// (a throwaway DB; see vitest.config.ts). Catches route wiring, validation, and
// serialization regressions that pure service tests can't. The app's listener is
// guarded (require.main === module), so we bind an ephemeral port ourselves.
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

beforeEach(() => {
  db.exec('DELETE FROM position_exits; DELETE FROM positions;');
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const getJson = async (path: string) => (await fetch(`${base}${path}`)).json();

describe('positions + journal routes (integration)', () => {
  it('creates a position, records an exit, and reflects it in journal stats', async () => {
    const created = await post('/api/positions', {
      assetType: 'stock',
      symbol: 'aapl',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-05-01',
    });
    expect(created.status).toBe(201);
    const pos = (await created.json()) as { id: number; symbol: string; status: string };
    expect(pos.symbol).toBe('AAPL'); // normalized server-side
    expect(pos.status).toBe('open');

    const exited = await post(`/api/positions/${pos.id}/exits`, {
      quantity: 10,
      exitPrice: 110,
      exitDate: '2026-05-10',
    });
    expect(exited.status).toBe(201);

    const stats = (await getJson('/api/journal/stats')) as { totalClosed: number; totalRealized: number; wins: number };
    expect(stats.totalClosed).toBe(1);
    expect(stats.totalRealized).toBe(100); // (110 − 100) × 10
    expect(stats.wins).toBe(1);
  });

  it('rejects an invalid create with 400', async () => {
    const res = await post('/api/positions', { assetType: 'stock' }); // missing required fields
    expect(res.status).toBe(400);
  });

  it('day stats reflect entries and P&L booked on a date', async () => {
    const created = await post('/api/positions', {
      assetType: 'stock',
      symbol: 'MSFT',
      side: 'long',
      quantity: 5,
      entryPrice: 50,
      entryDate: '2026-06-17',
    });
    const pos = (await created.json()) as { id: number };
    await post(`/api/positions/${pos.id}/exits`, { quantity: 5, exitPrice: 60, exitDate: '2026-06-17' });

    const day = (await getJson('/api/journal/today?date=2026-06-17')) as {
      entries: number;
      exits: number;
      realizedPnl: number;
    };
    expect(day).toMatchObject({ entries: 1, exits: 1, realizedPnl: 50 });
  });

  it('round-trips a positions import (merge)', async () => {
    const res = await post('/api/export/import', {
      mode: 'merge',
      positions: [
        {
          assetType: 'stock',
          symbol: 'NVDA',
          side: 'long',
          quantity: 40,
          entryPrice: 118,
          entryDate: '2026-05-12',
          exits: [{ quantity: 40, exitPrice: 131, exitDate: '2026-06-02' }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { imported: number; totalNow: number };
    expect(out.imported).toBe(1);

    const stats = (await getJson('/api/journal/stats')) as { totalClosed: number; totalRealized: number };
    expect(stats.totalClosed).toBe(1);
    expect(stats.totalRealized).toBe(520); // (131 − 118) × 40
  });
});

describe('alerts routes (integration)', () => {
  beforeEach(() => db.exec("DELETE FROM alerts; DELETE FROM settings WHERE key = 'alertScheduler';"));

  it('creates a 52-week-distance stock alert (regression: kind CHECK)', async () => {
    // On a fresh DB the old `kind` CHECK rejected high52/macross/low52 with a
    // 500; the rebuilt schema drops it. Validation now lives in the route.
    const res = await post('/api/alerts', { symbol: 'aapl', kind: 'high52', operator: 'above', threshold: -2 });
    expect(res.status).toBe(201);
    const a = (await res.json()) as { symbol: string; kind: string; assetType: string };
    expect(a).toMatchObject({ symbol: 'AAPL', kind: 'high52', assetType: 'stock' });
  });

  it('creates an option entry alert and auto-attaches a suggested exit', async () => {
    const res = await post('/api/alerts', {
      symbol: 'AAPL',
      assetType: 'option',
      kind: 'optmark',
      operator: 'above',
      threshold: 3,
      optionType: 'call',
      strike: 150,
      expiration: '2026-07-17',
      role: 'entry',
      plan: { entry: 'breakout over 150' },
    });
    expect(res.status).toBe(201);
    const a = (await res.json()) as {
      assetType: string;
      optionType: string;
      strike: number;
      role: string;
      plan: { entry: string; suggestedExit: string };
    };
    expect(a).toMatchObject({ assetType: 'option', optionType: 'call', strike: 150, role: 'entry' });
    expect(a.plan.entry).toBe('breakout over 150');
    expect(a.plan.suggestedExit).toContain('time-exit 7d before 2026-07-17');
  });

  it('rejects an option alert missing the contract fields with 400', async () => {
    const res = await post('/api/alerts', {
      symbol: 'AAPL',
      assetType: 'option',
      kind: 'optmark',
      operator: 'above',
      threshold: 3,
    });
    expect(res.status).toBe(400);
  });

  it('evaluate returns the standard envelope', async () => {
    const res = await post('/api/alerts/evaluate', {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as { alerts: unknown[]; newlyTriggered: unknown[]; positionAlerts: unknown[] };
    expect(Array.isArray(out.alerts)).toBe(true);
    expect(Array.isArray(out.newlyTriggered)).toBe(true);
    expect(Array.isArray(out.positionAlerts)).toBe(true);
  });

  it('reports notification status (webhook + scheduler) and toggles the poller', async () => {
    const status = (await getJson('/api/alerts/notifications')) as {
      webhook: { configured: boolean; format: string };
      scheduler: { enabled: boolean; intervalSeconds: number };
    };
    expect(status.scheduler).toEqual({ enabled: false, intervalSeconds: 60 }); // default off
    expect(typeof status.webhook.configured).toBe('boolean');

    const put = await fetch(`${base}/api/alerts/scheduler`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalSeconds: 30 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ enabled: true, intervalSeconds: 30 });
  });

  it('rejects an out-of-range poll interval with 400', async () => {
    const put = await fetch(`${base}/api/alerts/scheduler`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalSeconds: 5 }), // below the 15s floor
    });
    expect(put.status).toBe(400);
  });

  it('test notification is not delivered when no webhook is configured', async () => {
    const res = await post('/api/alerts/notifications/test', {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as { delivered: boolean };
    expect(out.delivered).toBe(false); // no ALERT_WEBHOOK_URL in the test env
  });
});
