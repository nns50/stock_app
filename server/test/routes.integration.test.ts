import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { db } from '../src/db';
import { config } from '../src/config';
import { totp } from '../src/services/totp';
import { setSetting } from '../src/db/settings';
import { createIntent } from '../src/db/orders';
import { addExit, createPosition } from '../src/db/positions';
import { setAutotradeConfig } from '../src/db/autotradeConfig';

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

  it('slippage compares live fills to their order limit price (entry + exit)', async () => {
    const entryIntent = createIntent(
      {
        symbol: 'AMC',
        assetKind: 'stock',
        side: 'buy',
        openClose: 'open',
        quantity: 5,
        orderType: 'limit',
        limitPrice: 2,
      },
      'slippage-entry',
    );
    const pos = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 5,
      entryPrice: 2.1, // filled 0.10 worse than the 2.00 limit
      entryDate: '2026-06-01',
      sourceIntentId: entryIntent.id,
    });
    const exitIntent = createIntent(
      {
        symbol: 'AMC',
        assetKind: 'stock',
        side: 'sell',
        openClose: 'close',
        quantity: 5,
        orderType: 'limit',
        limitPrice: 3,
      },
      'slippage-exit',
    );
    addExit(pos.id, { quantity: 5, exitPrice: 2.9, exitDate: '2026-06-05', sourceIntentId: exitIntent.id }); // 0.10 worse than the 3.00 limit

    const report = (await getJson('/api/journal/slippage')) as {
      trades: number;
      totalUsd: number;
      rows: { kind: string; perUnit: number; totalUsd: number }[];
    };
    expect(report.trades).toBe(2);
    expect(report.totalUsd).toBeCloseTo(1, 5); // 0.5 (entry) + 0.5 (exit), both adverse
    expect(report.rows.find((r) => r.kind === 'entry')).toMatchObject({ perUnit: 0.1, totalUsd: 0.5 });
    expect(report.rows.find((r) => r.kind === 'exit')).toMatchObject({ perUnit: 0.1, totalUsd: 0.5 });
  });

  it('excludes a manually logged position from slippage (no source order)', async () => {
    await post('/api/positions', {
      assetType: 'stock',
      symbol: 'MSFT',
      side: 'long',
      quantity: 1,
      entryPrice: 400,
      entryDate: '2026-06-01',
    });
    const report = (await getJson('/api/journal/slippage')) as { trades: number };
    expect(report.trades).toBe(0);
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

describe('trade (dry-run) routes (integration)', () => {
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => db.exec('DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM trading_config;'));

  const account = {
    buyingPowerUsd: 100_000,
    exposureUsd: 0,
    realizedPnlTodayUsd: 0,
    ordersToday: 0,
    currentPositionQty: 0,
  };
  const intent = {
    symbol: 'aapl',
    assetKind: 'stock',
    side: 'buy',
    openClose: 'open',
    quantity: 10,
    orderType: 'limit',
    limitPrice: 10,
    referencePrice: 10,
  };

  it('returns the default config and persists updates + kill switch', async () => {
    expect(await getJson('/api/trade/config')).toMatchObject({ enabled: false, killSwitch: false });

    const updated = await (await put('/api/trade/config', { enabled: true, maxOrderUsd: 1000 })).json();
    expect(updated).toMatchObject({ enabled: true, maxOrderUsd: 1000 });

    const killed = await (await post('/api/trade/kill-switch', { on: true })).json();
    expect(killed).toMatchObject({ killSwitch: true });
  });

  it('dry-runs a clean order to "would submit" without placing it', async () => {
    await put('/api/trade/config', { enabled: true });
    const r = (await (await post('/api/trade/dry-run', { intent, account })).json()) as {
      wouldSubmit: boolean;
      intent: { id: number; state: string; symbol: string };
      notional: number;
    };
    expect(r.wouldSubmit).toBe(true);
    expect(r.intent).toMatchObject({ state: 'validated', symbol: 'AAPL' });
    expect(r.notional).toBe(100);

    const list = (await getJson('/api/trade/intents')) as { intents: Array<{ id: number }> };
    expect(list.intents).toHaveLength(1);
    const events = (await getJson(`/api/trade/intents/${r.intent.id}/events`)) as {
      events: Array<{ state: string }>;
    };
    expect(events.events.map((e) => e.state)).toEqual(['draft', 'validated']);
  });

  it('dry-run rejects when the kill switch is engaged', async () => {
    await put('/api/trade/config', { enabled: true });
    await post('/api/trade/kill-switch', { on: true });
    const r = (await (await post('/api/trade/dry-run', { intent, account })).json()) as {
      wouldSubmit: boolean;
      intent: { state: string };
    };
    expect(r.wouldSubmit).toBe(false);
    expect(r.intent.state).toBe('rejected');
  });

  it('rejects a malformed dry-run body with 400', async () => {
    const res = await post('/api/trade/dry-run', { intent: { symbol: 'AAPL' }, account });
    expect(res.status).toBe(400);
  });

  it('account-state is read-only and guarded when Webull is unconfigured', async () => {
    const out = (await getJson('/api/trade/account-state?accountId=ACC1&symbol=AAPL')) as {
      ok: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });

  it('place refuses with no TRADING_ENABLED on the server (deploy gate)', async () => {
    const out = (await (
      await post('/api/trade/place', { intent, accountId: 'ACC1', confirmation: 'BUY 10 AAPL' })
    ).json()) as { placed: boolean; reason: string };
    expect(out).toMatchObject({ placed: false, reason: 'trading_disabled' });
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

describe('autotrade backtest routes (integration)', () => {
  // VNQ is on the default real-estate exclusion list (server/data/reExclusions.json),
  // so it's excluded before runBacktest ever fetches history or hits the network —
  // safe to exercise the real route end to end without mocking Polygon/Yahoo.
  const baseBody = {
    symbols: ['VNQ'],
    from: '2024-01-01',
    to: '2024-03-01',
    riskProfile: 'MODERATE',
    startingEquity: 100_000,
  };

  it('runs a plain backtest and reports the real-estate exclusion, with no trades', async () => {
    const res = await post('/api/autotrade/backtest', baseBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { trades: unknown[]; excludedSymbols: { symbol: string }[] };
      stats: { totalTrades: number };
    };
    expect(body.report.excludedSymbols).toEqual([{ symbol: 'VNQ', reason: 'On the real-estate exclusion list' }]);
    expect(body.report.trades).toEqual([]);
    expect(body.stats.totalTrades).toBe(0);
  });

  it('rejects a backtest request where to is before from', async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, from: '2024-03-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
  });

  it('rejects a backtest request with an empty symbols list', async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, symbols: [] });
    expect(res.status).toBe(400);
  });

  it('runs a walk-forward split and reports both windows with the exclusion applied to each', async () => {
    const res = await post('/api/autotrade/backtest/walk-forward', { ...baseBody, splitDate: '2024-02-01' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inSample: { report: { excludedSymbols: { symbol: string }[] }; stats: { totalTrades: number } };
      outOfSample: { report: { excludedSymbols: { symbol: string }[] }; stats: { totalTrades: number } };
      excludedSymbols: { symbol: string }[];
    };
    expect(body.excludedSymbols).toEqual([{ symbol: 'VNQ', reason: 'On the real-estate exclusion list' }]);
    expect(body.inSample.stats.totalTrades).toBe(0);
    expect(body.outOfSample.stats.totalTrades).toBe(0);
  });

  it('rejects a walk-forward request when splitDate is not between from and to', async () => {
    const beforeFrom = await post('/api/autotrade/backtest/walk-forward', { ...baseBody, splitDate: '2023-12-01' });
    expect(beforeFrom.status).toBe(400);
    const atOrAfterTo = await post('/api/autotrade/backtest/walk-forward', { ...baseBody, splitDate: '2024-03-01' });
    expect(atOrAfterTo.status).toBe(400);
  });

  it('rejects a walk-forward request missing splitDate', async () => {
    const res = await post('/api/autotrade/backtest/walk-forward', baseBody);
    expect(res.status).toBe(400);
  });

  it('rejects a structurally-invalid calendar date with 400, not a 500 crash', async () => {
    // Regex-shaped but not a real date (month 00) — used to reach addDays()/
    // toISO()'s `new Date(NaN).toISOString()`, an uncaught RangeError -> 500.
    const res = await post('/api/autotrade/backtest', { ...baseBody, from: '2024-00-00' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid calendar date/i);
  });

  it('rejects a calendar-overflow date (Feb 30) with 400 instead of silently rolling to March 1', async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, to: '2024-02-30' });
    expect(res.status).toBe(400);
  });

  it('rejects more than 50 symbols', async () => {
    const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}`);
    const res = await post('/api/autotrade/backtest', { ...baseBody, symbols });
    expect(res.status).toBe(400);
  });
});

describe('autotrade paper execution routes (integration)', () => {
  beforeEach(() => {
    db.exec('DELETE FROM autotrade_paper_positions; DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
    // runAutotradeLoopTick (Phase 7) gates new entries on autotrade_config.enabled
    // (and the kill switch) — arm it here so this test still exercises the real
    // Screen -> Decision -> Execution wiring end-to-end, not just the
    // always-runs exits path.
    setAutotradeConfig({ enabled: true });
  });

  it('runs one loop cycle through the real Screen -> Decision -> Execution wiring and returns a summary', async () => {
    // Nothing is open yet, so exits are deterministically zero regardless of
    // whatever the real wall-clock session-window state happens to be right
    // now (already covered, with full control, by autotradeLoop.test.ts).
    const res = await post('/api/autotrade/loop/run-once', {});
    expect(res.status).toBe(200);
    const summary = (await res.json()) as {
      exitsChecked: number;
      exitsClosed: number;
      ranEntries: boolean;
      candidatesScreened: number;
    };
    expect(summary.exitsChecked).toBe(0);
    expect(summary.exitsClosed).toBe(0);
    expect(typeof summary.ranEntries).toBe('boolean');
  });

  it('lists paper positions (empty when none exist)', async () => {
    const body = (await getJson('/api/autotrade/paper-positions')) as { positions: unknown[] };
    expect(body.positions).toEqual([]);
  });

  it('rejects an invalid status filter', async () => {
    const res = await fetch(`${base}/api/autotrade/paper-positions?status=bogus`);
    expect(res.status).toBe(400);
  });
});

describe('autotrade monitoring dashboard + kill switch routes (integration)', () => {
  beforeEach(() => {
    db.exec('DELETE FROM autotrade_paper_positions; DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
  });

  it('GET /dashboard returns a full snapshot with safe defaults', async () => {
    const dash = (await getJson('/api/autotrade/dashboard')) as {
      enabled: boolean;
      killSwitch: boolean;
      riskProfile: string;
      equity: number | null;
      openPositionsCount: number;
      maxConcurrentPositions: number;
      maxTradesPerDay: number;
    };
    expect(dash.enabled).toBe(false);
    expect(dash.killSwitch).toBe(false);
    expect(dash.riskProfile).toBe('MODERATE');
    expect(dash.equity).toBeNull();
    expect(dash.openPositionsCount).toBe(0);
    expect(dash.maxConcurrentPositions).toBe(2);
    expect(dash.maxTradesPerDay).toBe(6);
  });

  it('POST /kill-switch engages and releases, journaling each transition', async () => {
    const engaged = await post('/api/autotrade/kill-switch', { on: true });
    expect(engaged.status).toBe(200);
    expect((await engaged.json()) as { killSwitch: boolean }).toMatchObject({ killSwitch: true });
    expect(((await getJson('/api/autotrade/dashboard')) as { killSwitch: boolean }).killSwitch).toBe(true);

    const released = await post('/api/autotrade/kill-switch', { on: false });
    expect((await released.json()) as { killSwitch: boolean }).toMatchObject({ killSwitch: false });

    const events = (await getJson('/api/autotrade/events')) as {
      events: { action: string; stage: string }[];
    };
    const actions = events.events.map((e) => e.action);
    expect(actions).toContain('kill_switch_engaged');
    expect(actions).toContain('kill_switch_released');
  });

  it('POST /kill-switch rejects a non-boolean body', async () => {
    const res = await post('/api/autotrade/kill-switch', { on: 'yes' });
    expect(res.status).toBe(400);
  });

  it('engaging the kill switch does not touch the enabled flag', async () => {
    await setAutotradeConfigViaRoute({ enabled: true });
    await post('/api/autotrade/kill-switch', { on: true });
    const cfg = (await getJson('/api/autotrade/config')) as { enabled: boolean; killSwitch: boolean };
    expect(cfg.enabled).toBe(true);
    expect(cfg.killSwitch).toBe(true);
  });

  async function setAutotradeConfigViaRoute(body: unknown) {
    const res = await fetch(`${base}/api/autotrade/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return res;
  }
});
