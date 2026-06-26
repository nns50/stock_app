import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import {
  buildWebullStockOrder,
  buildWebullOptionOrder,
  webullPreviewOrder,
  webullPlaceOrder,
  webullOrderStatus,
  webullCancelOrder,
  newClientOrderId,
} from '../src/providers/webull/orders';
import type { OrderIntent } from '../src/services/trading/guardrails';

const orig = { ...config.webull };
afterEach(() => {
  Object.assign(config.webull, orig);
  vi.restoreAllMocks();
});

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

describe('webull stock order + preview', () => {
  it('builds a Webull EQUITY limit order body', () => {
    expect(buildWebullStockOrder(intent(), 'CID123')).toMatchObject({
      combo_type: 'NORMAL',
      client_order_id: 'CID123',
      symbol: 'AAPL',
      instrument_type: 'EQUITY',
      market: 'US',
      order_type: 'LIMIT',
      side: 'BUY',
      quantity: '1',
      entrust_type: 'QTY',
      time_in_force: 'DAY',
      support_trading_session: 'CORE',
      limit_price: '5',
    });
  });

  it('omits limit_price for a market order', () => {
    const o = buildWebullStockOrder(intent({ orderType: 'market', limitPrice: undefined }), 'C');
    expect(o.order_type).toBe('MARKET');
    expect(o.limit_price).toBeUndefined();
  });

  it('maps the trading session to support_trading_session (default CORE)', () => {
    expect(buildWebullStockOrder(intent(), 'C').support_trading_session).toBe('CORE');
    expect(buildWebullStockOrder(intent({ session: 'core' }), 'C').support_trading_session).toBe('CORE');
    expect(buildWebullStockOrder(intent({ session: 'extended' }), 'C').support_trading_session).toBe('ALL');
    expect(buildWebullStockOrder(intent({ session: 'overnight' }), 'C').support_trading_session).toBe('NIGHT');
  });

  it('builds a single-leg OPTION order body matching the docs example (order + leg fields)', () => {
    const opt = intent({
      assetKind: 'option',
      symbol: 'nvda',
      side: 'buy',
      openClose: 'open',
      quantity: 3,
      optionType: 'call',
      strike: 202.5,
      expiration: '2026-06-24',
      limitPrice: 0.45,
    });
    const body = buildWebullOptionOrder(opt, 'CID-OPT');
    // Order level: side / market / symbol all present (per the official example).
    expect(body).toMatchObject({
      combo_type: 'NORMAL',
      client_order_id: 'CID-OPT',
      instrument_type: 'OPTION',
      market: 'US',
      symbol: 'NVDA',
      option_strategy: 'SINGLE',
      side: 'BUY',
      order_type: 'LIMIT',
      time_in_force: 'DAY',
      entrust_type: 'QTY',
      limit_price: '0.45',
    });
    // No position_intent (the broker derives it) and no support_trading_session.
    expect(body.position_intent).toBeUndefined();
    expect(body.support_trading_session).toBeUndefined();
    // Leg repeats side/symbol/market and carries instrument_type:'OPTION'.
    expect(body.legs).toEqual([
      {
        side: 'BUY',
        quantity: '3',
        symbol: 'NVDA',
        strike_price: '202.5',
        option_expire_date: '2026-06-24',
        instrument_type: 'OPTION',
        option_type: 'CALL',
        market: 'US',
      },
    ]);
  });

  it('carries SELL through to the order and leg side', () => {
    const body = buildWebullOptionOrder(
      intent({
        assetKind: 'option',
        side: 'sell',
        openClose: 'close',
        optionType: 'put',
        strike: 15,
        expiration: '2026-06-26',
      }),
      'C',
    );
    expect(body.side).toBe('SELL');
    expect((body.legs as Array<{ side: string }>)[0].side).toBe('SELL');
  });

  it('client_order_id is ≤32 chars', () => {
    expect(newClientOrderId().length).toBeLessThanOrEqual(32);
  });

  it('errors cleanly without keys (no network)', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    expect((await webullPreviewOrder('ACC1', intent())).error).toMatch(/not configured/i);
  });

  it('POSTs the preview to /openapi/trade/order/preview with { account_id, new_orders } (places nothing)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ estimated_cost: '5.00', estimated_commission: '0.00' }),
    } as Response);

    const r = await webullPreviewOrder('ACC1', intent());
    expect(r.ok).toBe(true);
    expect(r.estimate?.costUsd).toBe(5);

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('api.webull.com/openapi/trade/order/preview');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.account_id).toBe('ACC1');
    expect(body.new_orders[0]).toMatchObject({ symbol: 'AAPL', instrument_type: 'EQUITY', order_type: 'LIMIT' });
  });

  it('surfaces a preview error cleanly', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ msg: 'insufficient buying power' }),
    } as Response);
    const r = await webullPreviewOrder('ACC1', intent());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/insufficient buying power/i);
  });

  it('places to /openapi/trade/order/place with the given client_order_id, parsing order_id', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ order_id: 'WB-9' }),
    } as Response);

    const r = await webullPlaceOrder('ACC1', intent(), 'CID-ABC');
    expect(r).toMatchObject({ ok: true, orderId: 'WB-9' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('api.webull.com/openapi/trade/order/place');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.new_orders[0].client_order_id).toBe('CID-ABC');
  });

  it('surfaces a place error cleanly (claims no order id)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ msg: 'trading not permitted' }),
    } as Response);
    const r = await webullPlaceOrder('ACC1', intent(), 'CID');
    expect(r.ok).toBe(false);
    expect(r.orderId).toBeUndefined();
    expect(r.error).toMatch(/trading not permitted/i);
  });

  it('finds an order status in open orders by client_order_id (no history call needed)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const env = {
      client_order_id: 'CID-OPEN',
      combo_order_id: 'WB-OPEN-1',
      orders: [{ status: 'PENDING', order_id: 'WB-OPEN-1', total_quantity: '2', filled_quantity: '0' }],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([env]),
    } as Response);

    const r = await webullOrderStatus('ACC1', 'CID-OPEN');
    expect(r).toMatchObject({ ok: true, found: true, status: 'PENDING', brokerOrderId: 'WB-OPEN-1', totalQty: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // short-circuits before history
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/openapi/trade/order/open');
  });

  it('reports not-found when neither open nor history has the order', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '[]' } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '[]' } as Response);
    const r = await webullOrderStatus('ACC1', 'CID-MISSING');
    expect(r).toMatchObject({ ok: true, found: false });
  });

  it('POSTs a cancel to /openapi/trade/order/cancel keyed by client_order_id', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);

    const r = await webullCancelOrder('ACC1', 'CID-CANCEL');
    expect(r.ok).toBe(true);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/openapi/trade/order/cancel');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({ account_id: 'ACC1', client_order_id: 'CID-CANCEL' });
  });

  it('surfaces a cancel error cleanly', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ msg: 'order already filled' }),
    } as Response);
    const r = await webullCancelOrder('ACC1', 'CID');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already filled/i);
  });
});
