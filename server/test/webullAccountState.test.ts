import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import { webullAccountState } from '../src/providers/webull/accountState';

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
});

// The confirmed live /openapi/assets/balance shape (every value a string).
const BALANCE = {
  total_asset_currency: 'USD',
  total_net_liquidation_value: '15.31',
  total_market_value: '4.50',
  total_cash_balance: '10.81',
  total_unrealized_profit_loss: '-130.50',
  total_day_profit_loss: '0.00',
  account_currency_assets: [
    {
      currency: 'USD',
      buying_power: '10.81',
      option_buying_power: '10.81',
      settled_cash: '10.81',
      market_value: '4.50',
    },
  ],
};

const okResp = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

describe('webull account state', () => {
  it('is a clean error without keys', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const r = await webullAccountState('ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('maps the confirmed balance shape into AccountState (strings → numbers)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp(BALANCE));
    const r = await webullAccountState('ACC1'); // no symbol → no positions call
    expect(r.ok).toBe(true);
    expect(r.state).toMatchObject({
      buyingPowerUsd: 10.81,
      exposureUsd: 4.5,
      realizedPnlTodayUsd: 0,
      ordersToday: 0,
      currentPositionQty: 0,
    });
    expect(r.optionBuyingPowerUsd).toBe(10.81);
    expect(r.netLiquidationUsd).toBe(15.31);
  });

  it('sums the signed position for the requested symbol', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positions = [
      { symbol: 'AAPL', quantity: '7', position_side: 'LONG', asset_type: 'STOCK', cost_price: '100' },
      { symbol: 'TSLA', quantity: '3', position_side: 'LONG', asset_type: 'STOCK', cost_price: '200' },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance
      .mockResolvedValueOnce(okResp(positions)); // positions
    const r = await webullAccountState('ACC1', 'aapl');
    expect(r.state?.currentPositionQty).toBe(7); // AAPL long 7; TSLA ignored
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/openapi/assets/positions');
  });

  it('surfaces a balance error cleanly', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'no permission' }),
    } as Response);
    const r = await webullAccountState('ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no permission/i);
  });
});
