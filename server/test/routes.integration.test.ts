import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { db } from '../src/db';
import { config } from '../src/config';
import { totp } from '../src/services/totp';
import { setSetting } from '../src/db/settings';

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

  it('reports notification status (channels + scheduler) and toggles the poller', async () => {
    const status = (await getJson('/api/alerts/notifications')) as {
      channels: { label: string; format: string }[];
      configured: boolean;
      scheduler: { enabled: boolean; intervalSeconds: number };
    };
    expect(status.scheduler).toEqual({ enabled: false, intervalSeconds: 60 }); // default off
    expect(Array.isArray(status.channels)).toBe(true);
    expect(typeof status.configured).toBe('boolean');

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

describe('webull connectivity (integration)', () => {
  it('reports not-configured and probes safely without credentials', async () => {
    // No WEBULL_APP_KEY/SECRET in the test env.
    const status = (await getJson('/api/webull/status')) as { configured: boolean; region: string };
    expect(status).toMatchObject({ configured: false, region: 'us', hasAccessToken: false });

    const res = await post('/api/webull/probe', { kind: 'snapshot', symbol: 'AAPL' });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false); // guarded — never hits the network when unconfigured
    expect(out.error).toMatch(/not configured/i);
  });

  it('rejects an unknown probe kind with 400', async () => {
    expect((await post('/api/webull/probe', { kind: 'place-order' })).status).toBe(400);
  });

  it('returns a guarded option-quotes result without credentials', async () => {
    const out = (await getJson('/api/webull/option-quotes?symbols=AAPL260622C00300000')) as {
      ok: boolean;
      quotes: unknown[];
      error?: string;
    };
    expect(out).toMatchObject({ ok: false, quotes: [] });
    expect(out.error).toMatch(/not configured/i);
  });
});

describe('auth gate (integration)', () => {
  afterEach(() => {
    config.auth.password = '';
  });

  it('allows all routes and reports not-required when no password is set', async () => {
    config.auth.password = '';
    expect((await fetch(`${base}/api/positions`)).status).toBe(200);
    expect(await getJson('/api/auth/status')).toMatchObject({ required: false, authenticated: true });
  });

  it('gates data routes when a password is set — but not /health or /auth', async () => {
    config.auth.password = 'letmein';
    expect((await fetch(`${base}/api/positions`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200); // health stays open for Fly checks
    expect(await getJson('/api/auth/status')).toMatchObject({ required: true, authenticated: false });
  });

  it('rejects a wrong password and unlocks routes with the session cookie', async () => {
    config.auth.password = 'letmein';
    expect((await post('/api/auth/login', { password: 'nope' })).status).toBe(401);

    const ok = await post('/api/auth/login', { password: 'letmein' });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toContain('sa_session=');

    expect((await fetch(`${base}/api/positions`, { headers: { cookie } })).status).toBe(200);
  });
});

describe('two-factor (integration)', () => {
  afterEach(() => {
    config.auth.password = '';
    db.exec("DELETE FROM settings WHERE key IN ('mfa', 'mfaPending')");
  });

  const loginCookie = async (body: object) => {
    const r = await post('/api/auth/login', body);
    return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
  };

  it('enrolls TOTP, then requires the code at login', async () => {
    config.auth.password = 'pw';
    const { cookie } = await loginCookie({ password: 'pw' });

    // Start enrollment and confirm with a freshly-computed code.
    const setup = await fetch(`${base}/api/auth/mfa/setup`, { method: 'POST', headers: { cookie } });
    const { secret } = (await setup.json()) as { secret: string };
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const enable = await fetch(`${base}/api/auth/mfa/enable`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: totp(secret) }),
    });
    expect(enable.status).toBe(200);

    // Password alone is no longer enough.
    expect((await loginCookie({ password: 'pw' })).status).toBe(401);
    const missing = await post('/api/auth/login', { password: 'pw' });
    expect((await missing.json()).code).toBe('mfa_required');
    expect((await loginCookie({ password: 'pw', code: '000000' })).status).toBe(401);

    // Password + a valid code logs in.
    expect((await loginCookie({ password: 'pw', code: totp(secret) })).status).toBe(200);
  });

  it('does not enforce MFA when DISABLE_MFA recovery is set', async () => {
    config.auth.password = 'pw';
    setSetting('mfa', { enabled: true, secret: 'JBSWY3DPEHPK3PXP' });
    config.auth.mfaDisabled = true;
    try {
      expect((await loginCookie({ password: 'pw' })).status).toBe(200); // code not required
    } finally {
      config.auth.mfaDisabled = false;
    }
  });
});
