import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { db } from '../src/db';
import { config } from '../src/config';
import { totp } from '../src/services/totp';
import { setSetting } from '../src/db/settings';
import { createIntent } from '../src/db/orders';
import { addExit, createPosition } from '../src/db/positions';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { openPaperPosition } from '../src/db/autotradePaperPositions';
import { openOptionsPaperPosition } from '../src/db/autotradeOptionsPaperPositions';
import { getProvider } from '../src/providers';

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

  beforeEach(() =>
    db.exec(
      'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
        'DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM trading_config;',
    ),
  );

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

describe('autotrade config routes (integration)', () => {
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
  });

  it('a save that omits a field does not reset that field to its default — enabled survives an equity-only save', async () => {
    const enabledRes = await put('/api/autotrade/config', { enabled: true });
    expect((await enabledRes.json()) as { enabled: boolean }).toMatchObject({ enabled: true });

    // A SEPARATE request that only sets equity, mirroring the UI's two
    // independent Save actions (the checkbox saves immediately on click; the
    // equity field has its own Save button) — must not touch `enabled`.
    const equityRes = await put('/api/autotrade/config', { accountEquityUsd: 100_000 });
    expect((await equityRes.json()) as { enabled: boolean; accountEquityUsd: number }).toMatchObject({
      enabled: true,
      accountEquityUsd: 100_000,
    });

    const final = (await getJson('/api/autotrade/config')) as { enabled: boolean; accountEquityUsd: number };
    expect(final.enabled).toBe(true);
    expect(final.accountEquityUsd).toBe(100_000);
  });

  it('a save that omits equity does not reset it to null — equity survives an enabled-only save', async () => {
    await put('/api/autotrade/config', { accountEquityUsd: 50_000 });
    await put('/api/autotrade/config', { enabled: true });

    const final = (await getJson('/api/autotrade/config')) as { enabled: boolean; accountEquityUsd: number | null };
    expect(final.accountEquityUsd).toBe(50_000);
    expect(final.enabled).toBe(true);
  });

  it('a save that omits riskProfile does not reset it to MODERATE — riskProfile survives an equity-only save', async () => {
    await put('/api/autotrade/config', { riskProfile: 'AGGRESSIVE', confirmAggressive: true });
    await put('/api/autotrade/config', { accountEquityUsd: 75_000 });

    const final = (await getJson('/api/autotrade/config')) as { riskProfile: string; accountEquityUsd: number };
    expect(final.riskProfile).toBe('AGGRESSIVE');
    expect(final.accountEquityUsd).toBe(75_000);
  });

  it('persists optionsStrategyType and survives an unrelated save, mirroring riskProfile', async () => {
    await put('/api/autotrade/config', { optionsStrategyType: 'debit_spread' });
    await put('/api/autotrade/config', { accountEquityUsd: 20_000 });

    const final = (await getJson('/api/autotrade/config')) as {
      optionsStrategyType: string;
      accountEquityUsd: number;
    };
    expect(final.optionsStrategyType).toBe('debit_spread');
    expect(final.accountEquityUsd).toBe(20_000);
  });

  it('persists tradeDirection and survives an unrelated save, mirroring optionsStrategyType', async () => {
    await put('/api/autotrade/config', { tradeDirection: 'both' });
    await put('/api/autotrade/config', { accountEquityUsd: 20_000 });

    const final = (await getJson('/api/autotrade/config')) as {
      tradeDirection: string;
      accountEquityUsd: number;
    };
    expect(final.tradeDirection).toBe('both');
    expect(final.accountEquityUsd).toBe(20_000);
  });

  it('persists the risk-check parameters (formerly the riskProfile preset table) and survives an unrelated save', async () => {
    await put('/api/autotrade/config', {
      riskPerTradePct: 1.5,
      maxDailyDrawdownPct: 5,
      stepDownAfterLosses: 3,
      stepDownSizeCutPct: 25,
      maxAggregateOpenRiskPct: 4.5,
      maxCorrelatedExposurePct: 10,
      maxTradesPerDay: 10,
    });
    await put('/api/autotrade/config', { accountEquityUsd: 30_000 });

    const final = (await getJson('/api/autotrade/config')) as {
      riskPerTradePct: number;
      maxDailyDrawdownPct: number;
      stepDownAfterLosses: number;
      stepDownSizeCutPct: number;
      maxAggregateOpenRiskPct: number;
      maxCorrelatedExposurePct: number;
      maxTradesPerDay: number;
      accountEquityUsd: number;
    };
    expect(final).toMatchObject({
      riskPerTradePct: 1.5,
      maxDailyDrawdownPct: 5,
      stepDownAfterLosses: 3,
      stepDownSizeCutPct: 25,
      maxAggregateOpenRiskPct: 4.5,
      maxCorrelatedExposurePct: 10,
      maxTradesPerDay: 10,
      accountEquityUsd: 30_000,
    });
  });

  it('persists the screening/decision thresholds (formerly hardcoded constants) and survives an unrelated save', async () => {
    await put('/api/autotrade/config', {
      minRelVol: 3,
      maxTickerAtrPct: 25,
      maxMarketAtrPct: 8,
      stopAtrMultiple: 2,
      targetRMultiple: 3,
      maxHoldDays: 10,
      breakevenTriggerRMultiple: 1,
      trailStartRMultiple: 1.5,
      trailStopRMultiple: 0.5,
      partialExitRMultiple: 2,
      partialExitPct: 75,
      earningsBlackoutDays: 3,
      sessionBufferMinutes: 30,
      correlationLookbackDays: 45,
      correlationThreshold: 0.6,
    });
    await put('/api/autotrade/config', { accountEquityUsd: 30_000 });

    const final = (await getJson('/api/autotrade/config')) as {
      minRelVol: number;
      maxTickerAtrPct: number;
      maxMarketAtrPct: number;
      stopAtrMultiple: number;
      targetRMultiple: number;
      maxHoldDays: number;
      breakevenTriggerRMultiple: number;
      trailStartRMultiple: number;
      trailStopRMultiple: number;
      partialExitRMultiple: number;
      partialExitPct: number;
      earningsBlackoutDays: number;
      sessionBufferMinutes: number;
      correlationLookbackDays: number;
      correlationThreshold: number;
      accountEquityUsd: number;
    };
    expect(final).toMatchObject({
      minRelVol: 3,
      maxTickerAtrPct: 25,
      maxMarketAtrPct: 8,
      stopAtrMultiple: 2,
      targetRMultiple: 3,
      maxHoldDays: 10,
      breakevenTriggerRMultiple: 1,
      trailStartRMultiple: 1.5,
      trailStopRMultiple: 0.5,
      partialExitRMultiple: 2,
      partialExitPct: 75,
      earningsBlackoutDays: 3,
      sessionBufferMinutes: 30,
      correlationLookbackDays: 45,
      correlationThreshold: 0.6,
      accountEquityUsd: 30_000,
    });
  });

  it('accountEquityUsd: null still explicitly clears it, distinct from omitting the field entirely', async () => {
    await put('/api/autotrade/config', { enabled: true, accountEquityUsd: 50_000 });
    const cleared = await put('/api/autotrade/config', { accountEquityUsd: null });
    expect((await cleared.json()) as { accountEquityUsd: number | null; enabled: boolean }).toMatchObject({
      accountEquityUsd: null,
      enabled: true, // still untouched — only equity was explicitly cleared
    });
  });

  it('POST /sync-equity fails cleanly with no liveAccountId configured', async () => {
    const out = (await (await post('/api/autotrade/sync-equity', {})).json()) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/liveAccountId/i);
  });

  it('POST /sync-equity is read-only and guarded when Webull is unconfigured, even with liveAccountId set', async () => {
    await put('/api/autotrade/config', { liveAccountId: 'ACC1' });
    const out = (await (await post('/api/autotrade/sync-equity', {})).json()) as {
      ok: boolean;
      accountId?: string;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.accountId).toBe('ACC1');
    expect(out.error).toMatch(/not configured/i);
    // Unchanged — a failed sync never touches the persisted config.
    expect((await getJson('/api/autotrade/config')) as { accountEquityUsd: number | null }).toMatchObject({
      accountEquityUsd: null,
    });
  });

  describe('Phase 8: live-trading enable gate', () => {
    it('rejects enabling live trading with no confirmation phrase at all', async () => {
      const res = await put('/api/autotrade/config', { liveAccountId: 'ACC1', liveTradingEnabled: true });
      expect(res.status).toBe(400);
      expect(await getJson('/api/autotrade/config')).toMatchObject({ liveTradingEnabled: false });
    });

    it('rejects enabling live trading with the wrong phrase', async () => {
      const res = await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        confirmLiveTrading: 'yes please',
      });
      expect(res.status).toBe(400);
      expect(await getJson('/api/autotrade/config')).toMatchObject({ liveTradingEnabled: false });
    });

    it('rejects enabling live trading with no liveAccountId on file, even with the right phrase', async () => {
      const res = await put('/api/autotrade/config', {
        liveTradingEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      expect(res.status).toBe(400);
      expect(await getJson('/api/autotrade/config')).toMatchObject({ liveTradingEnabled: false });
    });

    it('accepts the correct phrase (case/whitespace-insensitive) plus an account, and stamps liveEnabledAt', async () => {
      const before = Date.now();
      const res = await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        confirmLiveTrading: '  enable live trading  ',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { liveTradingEnabled: boolean; liveEnabledAt: number | null };
      expect(body.liveTradingEnabled).toBe(true);
      expect(body.liveEnabledAt).not.toBeNull();
      expect(body.liveEnabledAt as number).toBeGreaterThanOrEqual(before);
    });

    it('does not require the phrase to turn live trading back off', async () => {
      await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      const res = await put('/api/autotrade/config', { liveTradingEnabled: false });
      expect(res.status).toBe(200);
      expect((await res.json()) as { liveTradingEnabled: boolean }).toMatchObject({ liveTradingEnabled: false });
    });

    it('does not re-require the phrase for an unrelated save while already enabled', async () => {
      await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      const res = await put('/api/autotrade/config', { liveMaxOrderUsd: 750 });
      expect(res.status).toBe(200);
      expect((await res.json()) as { liveTradingEnabled: boolean; liveMaxOrderUsd: number }).toMatchObject({
        liveTradingEnabled: true,
        liveMaxOrderUsd: 750,
      });
    });

    it('an unrelated save does not reset liveAccountId or the live caps to their defaults', async () => {
      await put('/api/autotrade/config', { liveAccountId: 'ACC1', liveMaxOrderUsd: 900 });
      await put('/api/autotrade/config', { enabled: true });
      const final = (await getJson('/api/autotrade/config')) as { liveAccountId: string; liveMaxOrderUsd: number };
      expect(final.liveAccountId).toBe('ACC1');
      expect(final.liveMaxOrderUsd).toBe(900);
    });

    describe('re-confirmation required to change the live account while already enabled', () => {
      // An adversarial review caught that this route originally let
      // liveAccountId be changed to a DIFFERENT value with no re-confirmation
      // at all once already enabled — silently redirecting real orders to a
      // different broker account.
      beforeEach(async () => {
        await put('/api/autotrade/config', {
          liveAccountId: 'ACC1',
          liveTradingEnabled: true,
          confirmLiveTrading: 'ENABLE LIVE TRADING',
        });
      });

      it('rejects switching to a different account with no confirmation phrase', async () => {
        const res = await put('/api/autotrade/config', { liveAccountId: 'ACC2' });
        expect(res.status).toBe(400);
        expect(await getJson('/api/autotrade/config')).toMatchObject({ liveAccountId: 'ACC1' }); // unchanged
      });

      it('accepts switching to a different account WITH the confirmation phrase', async () => {
        const res = await put('/api/autotrade/config', {
          liveAccountId: 'ACC2',
          confirmLiveTrading: 'ENABLE LIVE TRADING',
        });
        expect(res.status).toBe(200);
        expect(await getJson('/api/autotrade/config')).toMatchObject({
          liveAccountId: 'ACC2',
          liveTradingEnabled: true,
        });
      });

      it('does not require confirmation to re-send the SAME account id (a no-op resend)', async () => {
        const res = await put('/api/autotrade/config', { liveAccountId: 'ACC1' });
        expect(res.status).toBe(200);
        expect(await getJson('/api/autotrade/config')).toMatchObject({ liveAccountId: 'ACC1' });
      });

      it('rejects clearing the account (null) while remaining enabled, even with the confirmation phrase', async () => {
        const res = await put('/api/autotrade/config', {
          liveAccountId: null,
          confirmLiveTrading: 'ENABLE LIVE TRADING',
        });
        expect(res.status).toBe(400);
        expect(await getJson('/api/autotrade/config')).toMatchObject({ liveAccountId: 'ACC1' }); // unchanged
      });

      it('allows changing the account with no confirmation when the SAME request also disables live trading', async () => {
        const res = await put('/api/autotrade/config', { liveAccountId: 'ACC2', liveTradingEnabled: false });
        expect(res.status).toBe(200);
        expect(await getJson('/api/autotrade/config')).toMatchObject({
          liveAccountId: 'ACC2',
          liveTradingEnabled: false,
        });
      });
    });
  });

  describe('Task #70: live options trading enable gate', () => {
    it('rejects enabling live options trading while live trading itself is off', async () => {
      const res = await put('/api/autotrade/config', { liveOptionsEnabled: true });
      expect(res.status).toBe(400);
      expect(await getJson('/api/autotrade/config')).toMatchObject({ liveOptionsEnabled: false });
    });

    it('accepts enabling live options trading once live trading is already on, with no separate confirmation phrase', async () => {
      await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      const res = await put('/api/autotrade/config', { liveOptionsEnabled: true });
      expect(res.status).toBe(200);
      expect((await res.json()) as { liveOptionsEnabled: boolean }).toMatchObject({ liveOptionsEnabled: true });
    });

    it('accepts enabling both live trading and live options trading in the SAME request', async () => {
      const before = Date.now();
      const res = await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        liveOptionsEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        liveTradingEnabled: boolean;
        liveOptionsEnabled: boolean;
        liveOptionsEnabledAt: number | null;
      };
      expect(body).toMatchObject({ liveTradingEnabled: true, liveOptionsEnabled: true });
      expect(body.liveOptionsEnabledAt).not.toBeNull();
      expect(body.liveOptionsEnabledAt as number).toBeGreaterThanOrEqual(before);
    });

    it('stamps liveOptionsEnabledAt independently of liveEnabledAt', async () => {
      await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      const afterMaster = (await getJson('/api/autotrade/config')) as { liveEnabledAt: number };
      const res = await put('/api/autotrade/config', { liveOptionsEnabled: true });
      const body = (await res.json()) as { liveEnabledAt: number; liveOptionsEnabledAt: number };
      expect(body.liveEnabledAt).toBe(afterMaster.liveEnabledAt); // untouched by the options-only save
      expect(body.liveOptionsEnabledAt).toBeGreaterThanOrEqual(afterMaster.liveEnabledAt);
    });

    it('does not require confirmation to turn live options trading back off', async () => {
      await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        liveOptionsEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      const res = await put('/api/autotrade/config', { liveOptionsEnabled: false });
      expect(res.status).toBe(200);
      expect((await res.json()) as { liveOptionsEnabled: boolean }).toMatchObject({ liveOptionsEnabled: false });
    });

    it('an unrelated save does not reset liveOptionsEnabled or its dedicated caps to their defaults', async () => {
      await put('/api/autotrade/config', {
        liveAccountId: 'ACC1',
        liveTradingEnabled: true,
        liveOptionsEnabled: true,
        confirmLiveTrading: 'ENABLE LIVE TRADING',
      });
      await put('/api/autotrade/config', { liveOptionsMaxOrderUsd: 650 });
      const final = (await getJson('/api/autotrade/config')) as {
        liveOptionsEnabled: boolean;
        liveOptionsMaxOrderUsd: number;
      };
      expect(final.liveOptionsEnabled).toBe(true);
      expect(final.liveOptionsMaxOrderUsd).toBe(650);
    });

    it('leaving live trading off while sending liveOptionsEnabled: false is a harmless no-op, not an error', async () => {
      const res = await put('/api/autotrade/config', { liveOptionsEnabled: false });
      expect(res.status).toBe(200);
    });
  });

  it('GET /live-caps/suggest fails closed (400) when account equity is not set', async () => {
    const res = await fetch(`${base}/api/autotrade/live-caps/suggest`);
    expect(res.status).toBe(400);
  });

  it('GET /live-caps/suggest derives caps from equity and the configured drawdown/trade-count fields', async () => {
    await put('/api/autotrade/config', {
      accountEquityUsd: 100_000,
      maxDailyDrawdownPct: 5,
      maxTradesPerDay: 10,
    });
    const res = await fetch(`${base}/api/autotrade/live-caps/suggest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      liveMaxOrderUsd: number;
      liveMaxDailyLossUsd: number;
      liveMaxOrdersPerDay: number;
    };
    expect(body).toEqual({ liveMaxOrderUsd: 25_000, liveMaxDailyLossUsd: 5_000, liveMaxOrdersPerDay: 10 });
  });
});

describe('autotrade options risk-check route (integration)', () => {
  beforeEach(() => {
    db.exec('DELETE FROM autotrade_config; DELETE FROM autotrade_events;');
    setAutotradeConfig({ accountEquityUsd: 100_000, riskProfile: 'MODERATE' });
  });

  it('accepts a single_leg signal body (kind discriminant) and sizes by premium', async () => {
    const res = await post('/api/autotrade/risk-check-options', {
      signals: [
        {
          kind: 'single_leg',
          symbol: 'AAPL',
          side: 'call',
          contractSymbol: 'AAPL-fixture',
          strike: 100,
          expiration: '2024-06-21',
          dte: 21,
          premium: 3,
          delta: 0.45,
          ivRank: 50,
          maxLossPerContract: 300,
          rationale: 'fixture',
          score: 70,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { ok: boolean; sizing: { suggestedQuantity: number } }[] };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].sizing.suggestedQuantity).toBe(3); // 1% of $100k / $300 per contract
  });

  it('accepts a debit_spread signal body (kind discriminant) and sizes by max loss per spread', async () => {
    const res = await post('/api/autotrade/risk-check-options', {
      signals: [
        {
          kind: 'debit_spread',
          symbol: 'AAPL',
          side: 'call',
          expiration: '2024-06-21',
          dte: 21,
          ivRank: 50,
          longContractSymbol: 'AAPL-long',
          longStrike: 100,
          longPremium: 3,
          longDelta: 0.45,
          shortContractSymbol: 'AAPL-short',
          shortStrike: 110,
          shortPremium: 1,
          shortDelta: 0.2,
          width: 10,
          netDebit: 2,
          maxLossPerContract: 200,
          maxProfitPerContract: 800,
          rationale: 'fixture',
          score: 70,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { ok: boolean; sizing: { suggestedContracts: number } }[] };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].sizing.suggestedContracts).toBe(5); // 1% of $100k / $200 max loss per spread
  });

  it('rejects a signal body with no kind discriminant at all', async () => {
    const res = await post('/api/autotrade/risk-check-options', {
      signals: [{ symbol: 'AAPL', side: 'call', score: 70 }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a debit_spread body missing spread-only fields (e.g. shortStrike)', async () => {
    const res = await post('/api/autotrade/risk-check-options', {
      signals: [
        {
          kind: 'debit_spread',
          symbol: 'AAPL',
          side: 'call',
          expiration: '2024-06-21',
          dte: 21,
          ivRank: 50,
          longContractSymbol: 'AAPL-long',
          longStrike: 100,
          longPremium: 3,
          longDelta: 0.45,
          // shortContractSymbol/shortStrike/etc. deliberately omitted
          width: 10,
          netDebit: 2,
          maxLossPerContract: 200,
          maxProfitPerContract: 800,
          rationale: 'fixture',
          score: 70,
        },
      ],
    });
    expect(res.status).toBe(400);
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
    maxConcurrentPositions: 2,
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

  it('rejects a backtest request spanning more than 3 years', async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, from: '2020-01-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot exceed/i);
  });

  it('accepts a backtest request spanning exactly 3 years', async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, from: '2021-01-01', to: '2024-01-01' });
    expect(res.status).toBe(200);
  });

  it("accepts a valid directionMode ('both')", async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, directionMode: 'both' });
    expect(res.status).toBe(200);
  });

  it('rejects an invalid directionMode', async () => {
    const res = await post('/api/autotrade/backtest', { ...baseBody, directionMode: 'sideways' });
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

describe('autotrade options backtest routes (integration)', () => {
  // Same VNQ real-estate-exclusion trick as the equity backtest routes above
  // — excluded before runOptionsBacktest ever fetches equity bars OR option
  // contract reference data, so this exercises the real route end to end
  // without mocking Polygon/Yahoo.
  const baseBody = {
    symbols: ['VNQ'],
    from: '2024-01-01',
    to: '2024-03-01',
    riskProfile: 'MODERATE',
    startingEquity: 100_000,
    maxConcurrentPositions: 2,
  };

  it('runs a plain options backtest and reports the real-estate exclusion, with no trades', async () => {
    const res = await post('/api/autotrade/backtest-options', baseBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { trades: unknown[]; excludedSymbols: { symbol: string }[] };
      stats: { totalTrades: number };
    };
    expect(body.report.excludedSymbols).toEqual([{ symbol: 'VNQ', reason: 'On the real-estate exclusion list' }]);
    expect(body.report.trades).toEqual([]);
    expect(body.stats.totalTrades).toBe(0);
  });

  it('rejects an options backtest request where to is before from', async () => {
    const res = await post('/api/autotrade/backtest-options', { ...baseBody, from: '2024-03-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
  });

  it('rejects an options backtest request spanning more than 3 years', async () => {
    const res = await post('/api/autotrade/backtest-options', { ...baseBody, from: '2020-01-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot exceed/i);
  });

  it('rejects an options backtest request with an empty symbols list', async () => {
    const res = await post('/api/autotrade/backtest-options', { ...baseBody, symbols: [] });
    expect(res.status).toBe(400);
  });

  it('runs an options walk-forward split and reports both windows with the exclusion applied to each', async () => {
    const res = await post('/api/autotrade/backtest-options/walk-forward', { ...baseBody, splitDate: '2024-02-01' });
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

  it('rejects an options walk-forward request when splitDate is not between from and to', async () => {
    const beforeFrom = await post('/api/autotrade/backtest-options/walk-forward', {
      ...baseBody,
      splitDate: '2023-12-01',
    });
    expect(beforeFrom.status).toBe(400);
    const atOrAfterTo = await post('/api/autotrade/backtest-options/walk-forward', {
      ...baseBody,
      splitDate: '2024-03-01',
    });
    expect(atOrAfterTo.status).toBe(400);
  });

  it('rejects a structurally-invalid calendar date with 400, not a 500 crash', async () => {
    const res = await post('/api/autotrade/backtest-options', { ...baseBody, from: '2024-00-00' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid calendar date/i);
  });

  it('rejects more than 50 symbols', async () => {
    const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}`);
    const res = await post('/api/autotrade/backtest-options', { ...baseBody, symbols });
    expect(res.status).toBe(400);
  });
});

describe('autotrade combined backtest routes (integration)', () => {
  // Same VNQ real-estate-exclusion trick as the other two backtest route
  // groups — excluded before runCombinedBacktest ever fetches equity bars OR
  // option contract reference data, so this exercises the real route end to
  // end without mocking Polygon/Yahoo.
  const baseBody = {
    symbols: ['VNQ'],
    from: '2024-01-01',
    to: '2024-03-01',
    riskProfile: 'MODERATE',
    startingEquity: 100_000,
    maxConcurrentPositions: 2,
  };

  it('runs a plain combined backtest and reports the real-estate exclusion, with no trades in either book', async () => {
    const res = await post('/api/autotrade/backtest-combined', baseBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { equityTrades: unknown[]; optionsTrades: unknown[]; excludedSymbols: { symbol: string }[] };
      stats: { totalTrades: number };
    };
    expect(body.report.excludedSymbols).toEqual([{ symbol: 'VNQ', reason: 'On the real-estate exclusion list' }]);
    expect(body.report.equityTrades).toEqual([]);
    expect(body.report.optionsTrades).toEqual([]);
    expect(body.stats.totalTrades).toBe(0);
  });

  it('rejects a combined backtest request where to is before from', async () => {
    const res = await post('/api/autotrade/backtest-combined', { ...baseBody, from: '2024-03-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
  });

  it('rejects a combined backtest request spanning more than 3 years', async () => {
    const res = await post('/api/autotrade/backtest-combined', { ...baseBody, from: '2020-01-01', to: '2024-01-01' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot exceed/i);
  });

  it('rejects a combined backtest request with an empty symbols list', async () => {
    const res = await post('/api/autotrade/backtest-combined', { ...baseBody, symbols: [] });
    expect(res.status).toBe(400);
  });

  it('runs a combined walk-forward split and reports both windows with the exclusion applied to each', async () => {
    const res = await post('/api/autotrade/backtest-combined/walk-forward', { ...baseBody, splitDate: '2024-02-01' });
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

  it('rejects a combined walk-forward request when splitDate is not between from and to', async () => {
    const beforeFrom = await post('/api/autotrade/backtest-combined/walk-forward', {
      ...baseBody,
      splitDate: '2023-12-01',
    });
    expect(beforeFrom.status).toBe(400);
    const atOrAfterTo = await post('/api/autotrade/backtest-combined/walk-forward', {
      ...baseBody,
      splitDate: '2024-03-01',
    });
    expect(atOrAfterTo.status).toBe(400);
  });

  it('rejects a structurally-invalid calendar date with 400, not a 500 crash', async () => {
    const res = await post('/api/autotrade/backtest-combined', { ...baseBody, from: '2024-00-00' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid calendar date/i);
  });

  it('rejects more than 50 symbols', async () => {
    const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}`);
    const res = await post('/api/autotrade/backtest-combined', { ...baseBody, symbols });
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

  it('enriches an OPEN position with a live quote and unrealized P&L, leaving a closed one alone', async () => {
    const open = openPaperPosition({
      symbol: 'AAPL',
      side: 'buy',
      quantity: 10,
      entryPrice: 1, // far below any real/mock quote, so unrealizedPnl is unambiguously positive
      stopPrice: 0.5,
      targetPrice: 100_000, // effectively unreachable — stays open for this test
      riskAmount: 5,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    const closed = openPaperPosition({
      symbol: 'MSFT',
      side: 'buy',
      quantity: 5,
      entryPrice: 50,
      stopPrice: 45,
      targetPrice: 60,
      riskAmount: 25,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    db.prepare(
      "UPDATE autotrade_paper_positions SET status='closed', exit_price=55, exit_at=?, exit_reason='target' WHERE id=?",
    ).run(Date.now(), closed.id);

    const liveQuote = await getProvider().getQuote('AAPL');
    const body = (await getJson('/api/autotrade/paper-positions')) as {
      positions: { id: number; symbol: string; currentPrice: number | null; unrealizedPnl: number | null }[];
    };

    const openRow = body.positions.find((p) => p.id === open.id)!;
    expect(openRow.currentPrice).toBe(liveQuote.last);
    expect(openRow.unrealizedPnl).toBeCloseTo((liveQuote.last - 1) * 10, 2);

    const closedRow = body.positions.find((p) => p.id === closed.id)!;
    expect(closedRow.currentPrice).toBeNull();
    expect(closedRow.unrealizedPnl).toBeNull();
  });

  it('rejects an invalid status filter', async () => {
    const res = await fetch(`${base}/api/autotrade/paper-positions?status=bogus`);
    expect(res.status).toBe(400);
  });
});

describe('autotrade options paper execution routes (integration)', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM autotrade_options_paper_positions; DELETE FROM autotrade_config; DELETE FROM autotrade_events;',
    );
  });

  it('lists options paper positions (empty when none exist)', async () => {
    const body = (await getJson('/api/autotrade/options-paper-positions')) as { positions: unknown[] };
    expect(body.positions).toEqual([]);
  });

  it('enriches an OPEN position with a live contract mark and unrealized P&L, leaving a closed one alone', async () => {
    const [expiration] = await getProvider().getOptionsExpirations('AAPL');
    const chain = await getProvider().getOptionsChain('AAPL', expiration);
    const contract = chain.calls[0];

    const open = openOptionsPaperPosition({
      symbol: 'AAPL',
      side: 'call',
      contractSymbol: contract.symbol,
      strike: contract.strike,
      expiration,
      quantity: 2,
      entryPrice: 0.01, // far below any real/mock mark, so unrealizedPnl is unambiguously positive
      riskAmount: 2,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    const closed = openOptionsPaperPosition({
      symbol: 'AAPL',
      side: 'put',
      contractSymbol: `${contract.symbol}-closed`,
      strike: contract.strike,
      expiration,
      quantity: 1,
      entryPrice: 1,
      riskAmount: 100,
      riskProfile: 'MODERATE',
      rationale: 'fixture',
    });
    db.prepare(
      "UPDATE autotrade_options_paper_positions SET status='closed', exit_price=0.5, exit_at=?, exit_reason='time_exit' WHERE id=?",
    ).run(Date.now(), closed.id);

    const mark = contract.mark ?? contract.last!;
    const body = (await getJson('/api/autotrade/options-paper-positions')) as {
      positions: { id: number; symbol: string; currentPrice: number | null; unrealizedPnl: number | null }[];
    };

    const openRow = body.positions.find((p) => p.id === open.id)!;
    expect(openRow.currentPrice).toBe(mark);
    expect(openRow.unrealizedPnl).toBeCloseTo((mark - 0.01) * 2 * 100, 2);

    const closedRow = body.positions.find((p) => p.id === closed.id)!;
    expect(closedRow.currentPrice).toBeNull();
    expect(closedRow.unrealizedPnl).toBeNull();
  });

  it('rejects an invalid status filter', async () => {
    const res = await fetch(`${base}/api/autotrade/options-paper-positions?status=bogus`);
    expect(res.status).toBe(400);
  });
});

describe('autotrade live positions route (integration)', () => {
  beforeEach(() => db.exec('DELETE FROM position_exits; DELETE FROM positions;'));

  it('lists live positions (empty when none exist)', async () => {
    const body = (await getJson('/api/autotrade/live-positions')) as { positions: unknown[] };
    expect(body.positions).toEqual([]);
  });

  it('only returns positions tagged autotrade, ignoring a human-placed live position', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      entryDate: '2026-07-01',
      tags: ['live', 'autotrade'],
    });
    createPosition({
      assetType: 'stock',
      symbol: 'MSFT',
      side: 'long',
      quantity: 5,
      entryPrice: 200,
      entryDate: '2026-07-01',
      tags: ['live'], // human-placed — must not appear
    });

    const body = (await getJson('/api/autotrade/live-positions')) as { positions: { symbol: string }[] };
    expect(body.positions.map((p) => p.symbol)).toEqual(['AAPL']);
  });

  it('enriches an OPEN position with a live quote and full P&L, leaving a closed one alone', async () => {
    const open = createPosition({
      assetType: 'stock',
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 1, // far below any real/mock quote, so unrealized P&L is unambiguously positive
      entryDate: '2026-07-01',
      tags: ['live', 'autotrade'],
    });
    const closed = createPosition({
      assetType: 'stock',
      symbol: 'MSFT',
      side: 'long',
      quantity: 5,
      entryPrice: 50,
      entryDate: '2026-06-01',
      tags: ['live', 'autotrade'],
    });
    addExit(closed.id, { quantity: 5, exitPrice: 60, exitDate: '2026-06-05' });

    const liveQuote = await getProvider().getQuote('AAPL');
    const body = (await getJson('/api/autotrade/live-positions')) as {
      positions: {
        id: number;
        symbol: string;
        currentPrice: number | null;
        pnl: { unrealizedPnl: number | null; realizedPnl: number };
      }[];
    };

    const openRow = body.positions.find((p) => p.id === open.id)!;
    expect(openRow.currentPrice).toBe(liveQuote.last);
    expect(openRow.pnl.unrealizedPnl).toBeCloseTo((liveQuote.last - 1) * 10, 2);

    // Unlike paper trading's routes, priceMap() (shared with the human
    // Positions page) resolves a price for closed positions too — a closed
    // position's own realized P&L (not currentPrice) is what matters here.
    const closedRow = body.positions.find((p) => p.id === closed.id)!;
    expect(closedRow.pnl.unrealizedPnl).toBe(0);
    expect(closedRow.pnl.realizedPnl).toBe((60 - 50) * 5); // 50
  });

  it('rejects an invalid status filter', async () => {
    const res = await fetch(`${base}/api/autotrade/live-positions?status=bogus`);
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

  it('POST /kill-switch dispatches a notification when engaging, but not when releasing', async () => {
    const origNotifications = { ...config.notifications };
    config.notifications.slackWebhookUrl = 'http://slack.test';
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        if (typeof url === 'string' && url.startsWith('http://slack.test')) {
          return { ok: true, status: 200 } as Response;
        }
        return realFetch(url as never, init);
      });
    try {
      await post('/api/autotrade/kill-switch', { on: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2); // the route's own POST + the dispatched webhook
      const webhookCall = fetchSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('http://slack.test'),
      )!;
      const body = JSON.parse(webhookCall[1]!.body as string) as { text: string };
      expect(body.text).toMatch(/kill switch ENGAGED/i);

      await post('/api/autotrade/kill-switch', { on: false });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // only the route's own POST — release doesn't notify
    } finally {
      Object.assign(config.notifications, origNotifications);
      fetchSpy.mockRestore();
    }
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
