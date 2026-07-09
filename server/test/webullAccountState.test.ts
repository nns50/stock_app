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

  it('counts ONLY the matching option contract for an option instrument (long stock does NOT count)', async () => {
    // Regression (hardening audit, HIGH): the old per-underlying sum let a long
    // STOCK position (or a different option contract) inflate currentPositionQty
    // for a single-leg option order — silently defeating allowNakedShort=false
    // for a SELL-to-open, since long stock does not cover a short option.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positions = [
      { symbol: 'AAPL', quantity: '100', position_side: 'LONG', asset_type: 'STOCK', cost_price: '150' },
      {
        symbol: 'AAPL',
        quantity: '2',
        position_side: 'LONG',
        asset_type: 'OPTION',
        option_type: 'CALL',
        strike_price: '150',
        option_expire_date: '2030-01-17',
        cost_price: '5',
      },
      {
        symbol: 'AAPL',
        quantity: '3',
        position_side: 'LONG',
        asset_type: 'OPTION',
        option_type: 'PUT',
        strike_price: '140',
        option_expire_date: '2030-01-17',
        cost_price: '2',
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp(BALANCE)).mockResolvedValueOnce(okResp(positions));
    const r = await webullAccountState('ACC1', 'AAPL', {
      assetKind: 'option',
      strike: 150,
      expiration: '2030-01-17',
      optionType: 'call',
    });
    // ONLY the matching 150 call (2) — not the 100 shares, not the 140 put.
    expect(r.state?.currentPositionQty).toBe(2);
  });

  it('counts ONLY stock for a stock instrument (option contracts do NOT count)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const positions = [
      { symbol: 'AAPL', quantity: '100', position_side: 'LONG', asset_type: 'STOCK', cost_price: '150' },
      {
        symbol: 'AAPL',
        quantity: '2',
        position_side: 'SHORT',
        asset_type: 'OPTION',
        option_type: 'CALL',
        strike_price: '150',
        option_expire_date: '2030-01-17',
        cost_price: '5',
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp(BALANCE)).mockResolvedValueOnce(okResp(positions));
    const r = await webullAccountState('ACC1', 'AAPL', { assetKind: 'stock' });
    expect(r.state?.currentPositionQty).toBe(100); // ONLY the shares — not the short call
  });

  it('flags positionsUnavailable (not a fabricated 0) when the positions call fails but balance succeeds', async () => {
    // Regression (hardening audit): balance OK + positions FAILED must not look
    // like a flat account. currentPositionQty stays 0 by default, but the flag
    // lets the human place/replace path fail closed instead of under-counting a
    // real holding for the position_size cap.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance OK
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ msg: 'positions down' }),
      } as Response);
    const r = await webullAccountState('ACC1', 'AAPL');
    expect(r.ok).toBe(true); // balance is usable
    expect(r.positionsUnavailable).toBe(true);
    expect(r.state?.currentPositionQty).toBe(0); // default, NOT a confirmed-flat 0
  });

  it('leaves positionsUnavailable falsy on the happy path', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(
        okResp([{ symbol: 'AAPL', quantity: '5', position_side: 'LONG', asset_type: 'STOCK', cost_price: '10' }]),
      );
    const r = await webullAccountState('ACC1', 'AAPL');
    expect(r.positionsUnavailable).toBeFalsy();
    expect(r.state?.currentPositionQty).toBe(5);
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
