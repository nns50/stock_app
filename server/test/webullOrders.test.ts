import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import {
  buildWebullStockOrder,
  buildWebullOptionOrder,
  buildOrderRequest,
  webullPreviewOrder,
  webullPlaceOrder,
  webullOrderStatus,
  webullCancelOrder,
  webullReplaceOrder,
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

  it('builds STOP_LOSS (market-on-trigger) and STOP_LOSS_LIMIT bodies with stop_price', () => {
    const stop = buildWebullStockOrder(intent({ orderType: 'stop_loss', stopPrice: 4.5, limitPrice: undefined }), 'C');
    expect(stop.order_type).toBe('STOP_LOSS');
    expect(stop.stop_price).toBe('4.5');
    expect(stop.limit_price).toBeUndefined();

    const stopLim = buildWebullStockOrder(
      intent({ orderType: 'stop_loss_limit', stopPrice: 4.5, limitPrice: 4.4 }),
      'C',
    );
    expect(stopLim.order_type).toBe('STOP_LOSS_LIMIT');
    expect(stopLim.stop_price).toBe('4.5');
    expect(stopLim.limit_price).toBe('4.4');
  });

  it('builds an option STOP_LOSS body (stop_price, order-level + leg fields)', () => {
    const body = buildWebullOptionOrder(
      intent({ assetKind: 'option', orderType: 'stop_loss', stopPrice: 0.3, strike: 6, expiration: '2026-07-17' }),
      'C',
    );
    expect(body.order_type).toBe('STOP_LOSS');
    expect(body.stop_price).toBe('0.3');
    expect((body.legs as Array<{ instrument_type: string }>)[0].instrument_type).toBe('OPTION');
  });

  it('buildOrderRequest: a plain order is one new_order; a stock bracket is MASTER + STOP_PROFIT + STOP_LOSS', () => {
    const plain = buildOrderRequest(intent(), 'CID');
    expect(plain.new_orders).toHaveLength(1);
    expect(plain.client_combo_order_id).toBeUndefined();

    const req = buildOrderRequest(
      intent({ orderType: 'limit', limitPrice: 10, side: 'buy', bracket: { takeProfitPrice: 12, stopLossPrice: 9 } }),
      'CID-MASTER',
    );
    expect(req.client_combo_order_id).toBeTruthy();
    expect(req.new_orders).toHaveLength(3);
    const [master, tp, sl] = req.new_orders as Array<Record<string, string>>;
    expect(master).toMatchObject({
      combo_type: 'MASTER',
      client_order_id: 'CID-MASTER',
      side: 'BUY',
      limit_price: '10',
      // Entry stays DAY — an unfilled entry shouldn't keep trying at a stale
      // price for days. Unlike the exit legs below, this is a fresh order
      // with no position to protect yet.
      time_in_force: 'DAY',
    });
    expect(tp).toMatchObject({
      combo_type: 'STOP_PROFIT',
      side: 'SELL',
      order_type: 'LIMIT',
      limit_price: '12',
      // GTC, not DAY — see bracketExit()'s own doc comment: these legs
      // protect an already-open position, so they must outlive one session.
      time_in_force: 'GTC',
    });
    expect(sl).toMatchObject({
      combo_type: 'STOP_LOSS',
      side: 'SELL',
      order_type: 'STOP_LOSS',
      stop_price: '9',
      time_in_force: 'GTC',
    });
  });

  it('buildOrderRequest: a single-leg option bracket is MASTER (option) + STOP_PROFIT + STOP_LOSS option exits', () => {
    const req = buildOrderRequest(
      intent({
        assetKind: 'option',
        optionStrategy: 'SINGLE',
        side: 'buy',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 0.5,
        optionType: 'call',
        strike: 100,
        expiration: '2026-07-17',
        bracket: { takeProfitPrice: 0.9, stopLossPrice: 0.3 },
      }),
      'CID-OB',
    );
    expect(req.client_combo_order_id).toBeTruthy();
    expect(req.new_orders).toHaveLength(3);
    const [master, tp, sl] = req.new_orders as Array<Record<string, unknown>>;
    expect(master).toMatchObject({ combo_type: 'MASTER', option_strategy: 'SINGLE', side: 'BUY', limit_price: '0.5' });
    expect(tp).toMatchObject({
      combo_type: 'STOP_PROFIT',
      order_type: 'LIMIT',
      side: 'SELL',
      limit_price: '0.9',
      instrument_type: 'OPTION',
      // Stays DAY, deliberately NOT GTC like the stock version — Webull
      // restricts OPTION sell-side orders to DAY-only (see
      // optionBracketExit()'s own doc comment); this is a real,
      // currently-unaddressed gap for live options specifically.
      time_in_force: 'DAY',
    });
    expect(sl).toMatchObject({
      combo_type: 'STOP_LOSS',
      order_type: 'STOP_LOSS',
      side: 'SELL',
      stop_price: '0.3',
      instrument_type: 'OPTION',
      time_in_force: 'DAY',
    });
    // Exit legs are OPTION legs on the same contract, opposite (SELL) side.
    expect((tp.legs as Array<Record<string, string>>)[0]).toMatchObject({
      side: 'SELL',
      option_type: 'CALL',
      strike_price: '100',
    });
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

  it('builds a VERTICAL spread body (option_strategy VERTICAL + 2 legs + net limit)', () => {
    const body = buildWebullOptionOrder(
      intent({
        assetKind: 'option',
        symbol: 'spy',
        side: 'buy', // net debit
        quantity: 1,
        limitPrice: 1.2, // NET debit
        optionStrategy: 'VERTICAL',
        optionLegs: [
          { side: 'buy', optionType: 'call', strike: 500, expiration: '2026-07-17' },
          { side: 'sell', optionType: 'call', strike: 505, expiration: '2026-07-17' },
        ],
      }),
      'CID-V',
    );
    expect(body).toMatchObject({
      option_strategy: 'VERTICAL',
      side: 'BUY',
      symbol: 'SPY',
      order_type: 'LIMIT',
      limit_price: '1.2',
      instrument_type: 'OPTION',
      market: 'US',
    });
    expect(body.legs).toEqual([
      {
        side: 'BUY',
        quantity: '1',
        symbol: 'SPY',
        strike_price: '500',
        option_expire_date: '2026-07-17',
        instrument_type: 'OPTION',
        option_type: 'CALL',
        market: 'US',
      },
      {
        side: 'SELL',
        quantity: '1',
        symbol: 'SPY',
        strike_price: '505',
        option_expire_date: '2026-07-17',
        instrument_type: 'OPTION',
        option_type: 'CALL',
        market: 'US',
      },
    ]);
  });

  it('builds a COVERED_STOCK body (EQUITY leg of 100×qty shares + short call, net debit)', () => {
    const body = buildWebullOptionOrder(
      intent({
        assetKind: 'option',
        symbol: 'aapl',
        side: 'buy', // net debit
        quantity: 2,
        limitPrice: 1.5, // net debit per share
        optionStrategy: 'COVERED',
        optionLegs: [{ side: 'sell', optionType: 'call', strike: 310, expiration: '2026-07-17' }],
      }),
      'CID-C',
    );
    expect(body).toMatchObject({
      option_strategy: 'COVERED_STOCK',
      side: 'BUY',
      symbol: 'AAPL',
      order_type: 'LIMIT',
      limit_price: '1.5',
      quantity: '2',
    });
    expect(body.legs).toEqual([
      { side: 'BUY', quantity: '200', symbol: 'AAPL', instrument_type: 'EQUITY', market: 'US' },
      {
        side: 'SELL',
        quantity: '2',
        symbol: 'AAPL',
        strike_price: '310',
        option_expire_date: '2026-07-17',
        instrument_type: 'OPTION',
        option_type: 'CALL',
        market: 'US',
      },
    ]);
  });

  it('builds an IRON_CONDOR body (4 option legs, order-level net credit)', () => {
    const body = buildWebullOptionOrder(
      intent({
        assetKind: 'option',
        symbol: 'spy',
        side: 'sell', // net credit
        quantity: 1,
        limitPrice: 0.8,
        optionStrategy: 'IRON_CONDOR',
        optionLegs: [
          { side: 'sell', optionType: 'put', strike: 480, expiration: '2026-07-17' },
          { side: 'buy', optionType: 'put', strike: 475, expiration: '2026-07-17' },
          { side: 'sell', optionType: 'call', strike: 520, expiration: '2026-07-17' },
          { side: 'buy', optionType: 'call', strike: 525, expiration: '2026-07-17' },
        ],
      }),
      'CID-IC',
    );
    expect(body).toMatchObject({
      option_strategy: 'IRON_CONDOR',
      side: 'SELL',
      symbol: 'SPY',
      order_type: 'LIMIT',
      limit_price: '0.8',
      quantity: '1',
    });
    expect(body.legs).toHaveLength(4);
    expect(
      (body.legs as Array<{ option_type: string; side: string }>).map((l) => `${l.side} ${l.option_type}`),
    ).toEqual(['SELL PUT', 'BUY PUT', 'SELL CALL', 'BUY CALL']);
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

  it('prefers an explicitly-tagged MASTER leg over array position for a bracket combo — even when it is NOT first', async () => {
    // An adversarial review flagged that this response shape is unconfirmed
    // against a real account, and that trusting orders[0] positionally could
    // misread a cancelled OCO exit sibling as the entry's own status if the
    // broker ever orders a bracket's legs with an exit first. This response
    // deliberately puts a CANCELLED exit leg at index 0 and the real,
    // FILLED master at index 1.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const env = {
      client_order_id: 'CID-BRACKET',
      combo_order_id: 'WB-BRACKET-1',
      orders: [
        { combo_type: 'STOP_LOSS', status: 'CANCELLED', order_id: 'WB-BRACKET-SL' },
        {
          combo_type: 'MASTER',
          status: 'FILLED',
          order_id: 'WB-BRACKET-MASTER',
          filled_quantity: '10',
          filled_price: '100',
        },
        { combo_type: 'STOP_PROFIT', status: 'WORKING', order_id: 'WB-BRACKET-TP' },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([env]),
    } as Response);

    const r = await webullOrderStatus('ACC1', 'CID-BRACKET');
    expect(r.status).toBe('FILLED'); // the MASTER leg's status, not orders[0]'s (CANCELLED)
    expect(r.filledQty).toBe(10);
    expect(r.legs).toHaveLength(3); // all three legs still surfaced for exit-leg detection
  });

  it('falls back to orders[0] when no leg is tagged MASTER — unaffected for verticals/covered/iron-condors/plain orders', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const env = {
      client_order_id: 'CID-VERTICAL',
      combo_order_id: 'WB-VERTICAL-1',
      orders: [{ combo_type: 'NORMAL', status: 'FILLED', order_id: 'WB-VERTICAL-1', filled_quantity: '1' }],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([env]),
    } as Response);

    const r = await webullOrderStatus('ACC1', 'CID-VERTICAL');
    expect(r.status).toBe('FILLED');
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

  it('POSTs a replace to /openapi/trade/order/replace with modify_orders (client_order_id + changed fields)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);

    const r = await webullReplaceOrder('ACC1', 'CID-REP', { quantity: 2, limitPrice: 179 });
    expect(r.ok).toBe(true);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/openapi/trade/order/replace');
    expect((opts as RequestInit).method).toBe('POST');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.account_id).toBe('ACC1');
    expect(body.modify_orders[0]).toEqual({ client_order_id: 'CID-REP', quantity: '2', limit_price: '179' });
  });
});

describe('price rounding (defensive backstop for sub-penny broker prices)', () => {
  // Regression: confirmed in production. Webull rejects the ENTIRE order
  // (bracket legs included) if any price isn't an exact $0.01 increment
  // ("Price increment should be 0.01 when price is equal to or greater than
  // 0.9999"). An upstream caller's own arithmetic (an ATR-based stop/target, a
  // computed net debit/credit) can produce a sub-penny float; priceStr() is
  // the last checkpoint before a price is serialized for the broker, so every
  // price field must come out rounded to the cent no matter what raw value
  // came in. 98.14816 / 103.70368 mirror the exact sub-penny values decide.ts
  // used to send (a 1.23456 ATR at a 1.5x/2R stop/target).

  it('rounds a sub-penny limit_price/stop_price on a stock order', () => {
    const o = buildWebullStockOrder(
      intent({ orderType: 'stop_loss_limit', limitPrice: 98.14816, stopPrice: 103.70368 }),
      'C',
    );
    expect(o.limit_price).toBe('98.15');
    expect(o.stop_price).toBe('103.7');
  });

  it('rounds sub-penny stock bracket exit-leg prices (stop/target straight from an unrounded caller)', () => {
    const req = buildOrderRequest(
      intent({
        orderType: 'limit',
        limitPrice: 100,
        bracket: { takeProfitPrice: 103.70368, stopLossPrice: 98.14816 },
      }),
      'CID-MASTER',
    );
    const [, tp, sl] = req.new_orders as Array<Record<string, string>>;
    expect(tp.limit_price).toBe('103.7');
    expect(sl.stop_price).toBe('98.15');
  });

  it('rounds sub-penny option bracket exit-leg prices', () => {
    const req = buildOrderRequest(
      intent({
        assetKind: 'option',
        optionStrategy: 'SINGLE',
        orderType: 'limit',
        limitPrice: 0.5,
        optionType: 'call',
        strike: 100,
        expiration: '2026-07-17',
        bracket: { takeProfitPrice: 103.70368, stopLossPrice: 98.14816 },
      }),
      'CID-OB',
    );
    const [, tp, sl] = req.new_orders as Array<Record<string, unknown>>;
    expect(tp.limit_price).toBe('103.7');
    expect(sl.stop_price).toBe('98.15');
  });

  it('rounds a sub-penny net limit_price on a VERTICAL spread', () => {
    const body = buildWebullOptionOrder(
      intent({
        assetKind: 'option',
        optionStrategy: 'VERTICAL',
        limitPrice: 98.14816,
        optionLegs: [
          { side: 'buy', optionType: 'call', strike: 500, expiration: '2026-07-17' },
          { side: 'sell', optionType: 'call', strike: 505, expiration: '2026-07-17' },
        ],
      }),
      'CID-V',
    );
    expect(body.limit_price).toBe('98.15');
  });

  it('rounds sub-penny prices in a replace patch', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);

    await webullReplaceOrder('ACC1', 'CID-REP', { limitPrice: 98.14816, stopPrice: 103.70368 });
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.modify_orders[0]).toMatchObject({ limit_price: '98.15', stop_price: '103.7' });
  });
});
