import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { createIntent, getIntent, transitionIntent } from '../src/db/orders';
import { setTradingConfig } from '../src/db/trading';
import { replaceIntent } from '../src/services/trading/replaceOrder';
import type { OrderIntent } from '../src/services/trading/guardrails';

const origWebull = { ...config.webull };
const origPlace = config.trading.placeEnabled;
const CID = 'replace-cid-1';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM trading_config;',
  );
  config.trading.placeEnabled = true;
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  setTradingConfig({ enabled: true });
});
afterEach(() => {
  config.trading.placeEnabled = origPlace;
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
});

const BALANCE = {
  total_market_value: '4.50',
  total_day_profit_loss: '0.00',
  total_net_liquidation_value: '15.31',
  account_currency_assets: [{ buying_power: '10.81', option_buying_power: '10.81' }],
};
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: 'AMC',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 1,
  orderType: 'limit',
  limitPrice: 1.5,
  referencePrice: 1.5,
  ...over,
});
const okResp = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as Response;

function workingIntentId(over: Partial<OrderIntent> = {}, key = CID): number {
  const rec = createIntent(intent(over), key);
  transitionIntent(rec.id, 'validated');
  transitionIntent(rec.id, 'confirmed');
  transitionIntent(rec.id, 'submitted');
  transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'WB-REP-1' });
  return rec.id;
}

describe('replaceIntent', () => {
  it('refuses when TRADING_ENABLED is off', async () => {
    config.trading.placeEnabled = false;
    const r = await replaceIntent(workingIntentId(), 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'trading_disabled' });
  });

  it('refuses a terminal order', async () => {
    const id = workingIntentId();
    transitionIntent(id, 'filled', { detail: 'filled' });
    const r = await replaceIntent(id, 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'not_open' });
  });

  it('refuses to modify a multi-leg spread in place (no account or broker call)', async () => {
    const id = workingIntentId({ assetKind: 'option', optionStrategy: 'VERTICAL' }, 'vert-cid');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await replaceIntent(id, 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'not_modifiable' });
    expect(r.error).toMatch(/spread/i);
    expect(fetchSpy).not.toHaveBeenCalled(); // gated before account state / broker
  });

  it('refuses to modify a bracketed order in place (cancel & re-place instead)', async () => {
    const id = workingIntentId({ bracket: { takeProfitPrice: 2.0, stopLossPrice: 1.0 } }, 'brk-cid');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await replaceIntent(id, 'ACC1', { quantity: 3 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'not_modifiable' });
    expect(r.error).toMatch(/bracket/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still modifies a single-leg option in place (SINGLE is not a combo)', async () => {
    const id = workingIntentId(
      { assetKind: 'option', optionType: 'call', strike: 2, expiration: '2030-01-18', optionStrategy: 'SINGLE' },
      'single-opt-cid',
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // account state: balance
      .mockResolvedValueOnce(okResp([])) // account state: positions
      .mockResolvedValueOnce(okResp({ ok: true })) // /replace
      .mockResolvedValueOnce(okResp([])) // reconcile: open
      .mockResolvedValueOnce(okResp([])); // reconcile: history
    // 1 contract × $0.05 × 100 = $5, within the mocked option buying power ($10.81).
    const r = await replaceIntent(id, 'ACC1', { limitPrice: 0.05 });
    expect(r).toMatchObject({ ok: true, replaced: true, reason: 'replaced' });
  });

  it('blocks when the modified order fails a guardrail (no broker call)', async () => {
    const id = workingIntentId();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([])); // account state only
    // 1000 × $1.50 = $1,500 > $500 cap
    const r = await replaceIntent(id, 'ACC1', { quantity: 1000 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'blocked' });
    expect(r.guardrails?.checks.find((c) => c.rule === 'order_notional')?.passed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no /replace
  });

  it('replaces, persists the new values, and reconciles', async () => {
    const id = workingIntentId();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // account state: balance
      .mockResolvedValueOnce(okResp([])) // account state: positions
      .mockResolvedValueOnce(okResp({ ok: true })) // /replace
      .mockResolvedValueOnce(okResp([])) // reconcile: open
      .mockResolvedValueOnce(okResp([])); // reconcile: history

    const r = await replaceIntent(id, 'ACC1', { quantity: 2, limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: true, reason: 'replaced' });
    expect(getIntent(id)).toMatchObject({ quantity: 2, limitPrice: 1.6 });
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/openapi/trade/order/replace');
  });

  it('reports a broker rejection without persisting the change', async () => {
    const id = workingIntentId();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ msg: 'too late' }),
      } as Response);

    const r = await replaceIntent(id, 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'broker_rejected' });
    expect(getIntent(id)?.limitPrice).toBe(1.5); // unchanged
  });
});
