import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { livePreview } from '../src/services/trading/livePreview';
import { setTradingConfig } from '../src/db/trading';
import type { OrderIntent } from '../src/services/trading/guardrails';

const orig = { ...config.webull };
beforeAll(() => initDb());
afterEach(() => {
  Object.assign(config.webull, orig);
  db.exec('DELETE FROM trading_config');
  vi.restoreAllMocks();
});

const BALANCE = {
  total_market_value: '4.50',
  total_day_profit_loss: '0.00',
  total_net_liquidation_value: '15.31',
  account_currency_assets: [{ buying_power: '10.81', option_buying_power: '10.81' }],
};
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: 'AAPL',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 1,
  orderType: 'limit',
  limitPrice: 5,
  referencePrice: 5,
  ...over,
});
const okResp = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as Response;

describe('live preview pipeline', () => {
  it('rejects options for now', async () => {
    const r = await livePreview(intent({ assetKind: 'option' }), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stocks/i);
  });

  it('errors when account state cannot load (not configured)', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const r = await livePreview(intent(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('pulls account state, passes guardrails, then previews (no place)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // account-state: balance
      .mockResolvedValueOnce(okResp([])) // account-state: positions (none)
      .mockResolvedValueOnce(okResp({ estimated_cost: '5.00' })); // preview

    const r = await livePreview(intent(), 'ACC1');
    expect(r.ok).toBe(true);
    expect(r.wouldSubmit).toBe(true);
    expect(r.accountState?.buyingPowerUsd).toBe(10.81);
    expect(r.preview?.ok).toBe(true);
    expect(r.preview?.estimate?.costUsd).toBe(5);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/openapi/trade/order/preview');
  });

  it('blocks (and skips the broker) when guardrails fail', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance: BP 10.81
      .mockResolvedValueOnce(okResp([])); // positions

    // 20 × $5 = $100 notional > $10.81 buying power ⇒ buying_power blocks.
    const r = await livePreview(intent({ quantity: 20 }), 'ACC1');
    expect(r.wouldSubmit).toBe(false);
    expect(r.preview).toBeUndefined(); // no broker call when blocked
    expect(fetchSpy).toHaveBeenCalledTimes(2); // balance + positions only
    expect(r.guardrails?.checks.find((c) => c.rule === 'buying_power')?.passed).toBe(false);
  });
});
