import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../src/config';
import {
  buildWebullStockOrder,
  buildWebullOptionOrder,
  buildOrderRequest,
  webullPreviewOrder,
  webullPlaceOrder,
  webullOrderStatus,
  webullOrderStatusBatch,
  webullCancelOrder,
  webullReplaceOrder,
  webullReplaceOrders,
  listWebullOpenOrders,
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

  it('defaults a sell to SELL (isShort omitted)', () => {
    expect(buildWebullStockOrder(intent({ side: 'sell' }), 'C').side).toBe('SELL');
  });

  it('a plain sell-to-close still maps to SELL even when isShort is explicitly false', () => {
    expect(buildWebullStockOrder(intent({ side: 'sell' }), 'C', false).side).toBe('SELL');
  });

  it('maps a sell that would open/extend a net-short position to SHORT, not SELL', () => {
    expect(buildWebullStockOrder(intent({ side: 'sell' }), 'C', true).side).toBe('SHORT');
  });

  it('a buy stays BUY regardless of isShort (isShort only ever applies to a sell)', () => {
    expect(buildWebullStockOrder(intent({ side: 'buy' }), 'C', true).side).toBe('BUY');
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

  it('buildOrderRequest: threads isShort through to a bracketed MASTER entry (a short entry still needs its bracket)', () => {
    const req = buildOrderRequest(
      intent({ orderType: 'limit', limitPrice: 10, side: 'sell', bracket: { takeProfitPrice: 8, stopLossPrice: 11 } }),
      'CID-MASTER',
      true,
    );
    const [master] = req.new_orders as Array<Record<string, string>>;
    expect(master.side).toBe('SHORT');
  });

  it('buildOrderRequest: threads isShort through to a plain (non-bracketed) sell order', () => {
    const req = buildOrderRequest(intent({ side: 'sell' }), 'CID', true);
    expect((req.new_orders[0] as Record<string, string>).side).toBe('SHORT');
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

  it('places a permitted short with side SHORT (isShort=true), not SELL', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ order_id: 'WB-9' }),
    } as Response);

    await webullPlaceOrder('ACC1', intent({ side: 'sell' }), 'CID-SHORT', true);

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.new_orders[0].side).toBe('SHORT');
  });

  it('preview reflects the same SHORT side a place would submit', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ estimated_cost: '5.00' }),
    } as Response);

    await webullPreviewOrder('ACC1', intent({ side: 'sell' }), true);

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.new_orders[0].side).toBe('SHORT');
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

  it('reconstructs a REAL bracket from sibling envelopes sharing a combo id', async () => {
    // The shape confirmed against a live account (capture:broker Q3): a bracket
    // is THREE top-level envelopes sharing one combo_order_id, each wrapping a
    // single leg, with combo_type on the ENVELOPE rather than the leg. Reading
    // only the matched envelope's own `orders` saw just the entry, so no exit
    // leg was ever detected through the order path and a stop/target fill was
    // only picked up later by the position sync at an ESTIMATED price.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const list = [
      {
        client_order_id: 'CID-ENTRY',
        combo_type: 'MASTER',
        combo_order_id: 'WB-COMBO-1',
        orders: [
          {
            client_order_id: 'CID-ENTRY',
            status: 'FILLED',
            order_id: 'WB-ENTRY',
            order_type: 'LIMIT',
            total_quantity: '10',
            filled_quantity: '10',
            filled_price: '100.5',
            limit_price: '100.6',
          },
        ],
      },
      {
        client_order_id: 'CID-STOP',
        combo_type: 'STOP_LOSS',
        combo_order_id: 'WB-COMBO-1',
        orders: [
          {
            client_order_id: 'CID-STOP',
            status: 'FILLED',
            order_id: 'WB-SL',
            order_type: 'STOP_LOSS',
            filled_price: '95.2',
            filled_quantity: '10',
            stop_price: '95',
          },
        ],
      },
      {
        client_order_id: 'CID-TGT',
        combo_type: 'STOP_PROFIT',
        combo_order_id: 'WB-COMBO-1',
        orders: [
          {
            client_order_id: 'CID-TGT',
            status: 'CANCELLED',
            order_id: 'WB-TP',
            order_type: 'LIMIT',
            limit_price: '110',
          },
        ],
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(list),
    } as Response);

    const r = await webullOrderStatus('ACC1', 'CID-ENTRY');

    // Top-level status is the order we asked about, not a sibling's.
    expect(r.status).toBe('FILLED');
    expect(r.filledQty).toBe(10);
    // All three legs surfaced, with the envelope's combo_type carried down.
    expect(r.legs).toHaveLength(3);
    expect(r.legs?.map((l) => l.comboType)).toEqual(['MASTER', 'STOP_LOSS', 'STOP_PROFIT']);
    // The entry is identified positively by OUR id, not by the label.
    expect(r.legs?.filter((l) => l.isRequested).map((l) => l.clientOrderId)).toEqual(['CID-ENTRY']);
    // ...which is what makes the filled stop detectable, at its REAL price.
    const exitFills = r.legs?.filter((l) => !l.isRequested && l.status === 'FILLED');
    expect(exitFills).toHaveLength(1);
    expect(exitFills?.[0]).toMatchObject({ clientOrderId: 'CID-STOP', filledPrice: 95.2 });
  });

  it('leaves a plain single order alone — no siblings, one leg', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const list = [
      {
        client_order_id: 'CID-SOLO',
        combo_order_id: 'WB-SOLO',
        orders: [
          { client_order_id: 'CID-SOLO', status: 'FILLED', order_id: 'WB-1', filled_quantity: '5', filled_price: '10' },
        ],
      },
      // A DIFFERENT combo id — must not be pulled in.
      {
        client_order_id: 'CID-OTHER',
        combo_order_id: 'WB-OTHER',
        orders: [{ client_order_id: 'CID-OTHER', status: 'WORKING', order_id: 'WB-2' }],
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(list),
    } as Response);

    const r = await webullOrderStatus('ACC1', 'CID-SOLO');
    expect(r.status).toBe('FILLED');
    expect(r.legs).toHaveLength(1);
    expect(r.legs?.[0]).toMatchObject({ clientOrderId: 'CID-SOLO', isRequested: true });
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

  // A bracket's take-profit and stop-loss rest as an OCO pair, and the broker
  // validates that group's balance PER REQUEST: modifying one leg on its own is
  // refused with "The number of take-profit orders and the number of stop-loss
  // orders must be the same". The live scale-out looped the legs and sent one
  // replace each, so it was refused 89 times on 2026-09-02 and had never once
  // executed. modify_orders was always an array; every caller just sent one.
  it('sends EVERY leg in ONE replace request, so an OCO pair stays balanced', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);

    const r = await webullReplaceOrders('ACC1', [
      { clientOrderId: 'CID-TP', quantity: 5 },
      { clientOrderId: 'CID-SL', quantity: 5 },
    ]);

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // ONE request, not one per leg
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.modify_orders).toEqual([
      { client_order_id: 'CID-TP', quantity: '5' },
      { client_order_id: 'CID-SL', quantity: '5' },
    ]);
  });

  it('keeps the single-order form working — it is now the batch form with one entry', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } as Response);

    await webullReplaceOrder('ACC1', 'CID-ONE', { stopPrice: 101.5 });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.modify_orders).toEqual([{ client_order_id: 'CID-ONE', stop_price: '101.5' }]);
  });

  it('refuses an empty batch rather than POSTing a no-op modify', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await webullReplaceOrders('ACC1', []);
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('listWebullOpenOrders', () => {
  // The shape a REAL account returns, per this file's own WebullOrderLeg
  // comment: a bracket is THREE separate top-level envelopes sharing a
  // combo_order_id, each wrapping its own single leg, with combo_type on the
  // ENVELOPE. mapOpenOrder read it off the sub-order only, so every
  // WebullOpenOrder.comboType came back undefined — and restingStopLeg, which
  // filters for STOP_LOSS to know which leg to ratchet, matched zero of two on
  // every tick. Breakeven and trailing stops had therefore never once moved a
  // live stop; measured 2026-09-02, DELL asked to move 434.52 -> 449.58 on a
  // position that ran to +2.07R and was refused every time with "no resting leg
  // identifiable as STOP_LOSS among 2 exit order(s)".
  it('reads combo_type from the ENVELOPE when the sub-order does not carry it', () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const envelopes = [
      {
        client_order_id: 'CID-MASTER',
        combo_order_id: 'WB-COMBO',
        combo_type: 'MASTER',
        orders: [{ client_order_id: 'CID-MASTER', symbol: 'AAPL', side: 'BUY', status: 'FILLED' }],
      },
      {
        client_order_id: 'CID-SL',
        combo_order_id: 'WB-COMBO',
        combo_type: 'STOP_LOSS',
        orders: [{ client_order_id: 'CID-SL', symbol: 'AAPL', side: 'SELL', status: 'WORKING' }],
      },
      {
        client_order_id: 'CID-TP',
        combo_order_id: 'WB-COMBO',
        combo_type: 'STOP_PROFIT',
        orders: [{ client_order_id: 'CID-TP', symbol: 'AAPL', side: 'SELL', status: 'WORKING' }],
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(envelopes),
    } as Response);

    return listWebullOpenOrders('ACC1').then((r) => {
      expect(r.ok).toBe(true);
      const byId = Object.fromEntries(r.orders.map((o) => [o.clientOrderId, o]));
      expect(byId['CID-SL'].comboType).toBe('STOP_LOSS');
      expect(byId['CID-TP'].comboType).toBe('STOP_PROFIT');
      expect(byId['CID-MASTER'].comboType).toBe('MASTER');
      // The consumer's own question: exactly one identifiable stop among the
      // resting exit legs.
      const sells = r.orders.filter((o) => o.side === 'sell');
      expect(sells.filter((o) => (o.comboType ?? '').toUpperCase() === 'STOP_LOSS')).toHaveLength(1);
    });
  });

  it('still prefers the SUB-ORDER combo_type when the response does nest it there', () => {
    // The other half — a response carrying it on the leg must keep working, so
    // the envelope is a fallback rather than an override.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const envelopes = [
      {
        client_order_id: 'CID-X',
        combo_type: 'MASTER',
        orders: [{ combo_type: 'STOP_LOSS', client_order_id: 'CID-SL2', symbol: 'AAPL', side: 'SELL' }],
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(envelopes),
    } as Response);

    return listWebullOpenOrders('ACC1').then((r) => {
      expect(r.orders[0].comboType).toBe('STOP_LOSS');
    });
  });

  it('flattens combo envelopes into one entry per sub-order, normalizing side/status', () => {
    // A bracket envelope (MASTER buy + two exit sells, each with its OWN
    // client_order_id) plus a standalone order — mirrors what the open-orders
    // endpoint returns, and is the ONLY way to recover the exit legs' ids.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const bracket = {
      client_order_id: 'CID-MASTER',
      combo_order_id: 'WB-COMBO',
      orders: [
        {
          combo_type: 'MASTER',
          client_order_id: 'CID-MASTER',
          symbol: 'AAPL',
          side: 'BUY',
          status: 'FILLED',
          order_id: 'WB-M',
        },
        {
          combo_type: 'STOP_LOSS',
          client_order_id: 'CID-SL',
          symbol: 'AAPL',
          side: 'SELL',
          status: 'WORKING',
          order_id: 'WB-SL',
        },
        {
          combo_type: 'STOP_PROFIT',
          client_order_id: 'CID-TP',
          symbol: 'AAPL',
          action: 'SELL',
          status: 'WORKING',
          order_id: 'WB-TP',
        },
      ],
    };
    const standalone = {
      client_order_id: 'CID-SOLO',
      orders: [{ client_order_id: 'CID-SOLO', symbol: 'MSFT', side: 'sell', status: 'PENDING', order_id: 'WB-SOLO' }],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([bracket, standalone]),
    } as Response);

    return listWebullOpenOrders('ACC1').then((r) => {
      expect(r.ok).toBe(true);
      expect(r.orders).toHaveLength(4);
      // The two exit legs are recoverable by their OWN client_order_ids, side-normalized.
      const sl = r.orders.find((o) => o.clientOrderId === 'CID-SL');
      expect(sl).toMatchObject({ symbol: 'AAPL', side: 'sell', status: 'WORKING', comboType: 'STOP_LOSS' });
      // `action` is accepted as a side alias.
      expect(r.orders.find((o) => o.clientOrderId === 'CID-TP')).toMatchObject({ side: 'sell' });
      expect(r.orders.find((o) => o.clientOrderId === 'CID-MASTER')).toMatchObject({ side: 'buy', status: 'FILLED' });
    });
  });

  it('fails closed (ok:false, no orders) when the broker call errors', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ msg: 'server error' }),
    } as Response);

    const r = await listWebullOpenOrders('ACC1');
    expect(r).toMatchObject({ ok: false, orders: [] });
    expect(r.error).toMatch(/server error/i);
  });

  it('returns not-configured (never throws) when Webull keys are unset', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '', region: '' });
    const r = await listWebullOpenOrders('ACC1');
    expect(r).toMatchObject({ ok: false, orders: [] });
    expect(r.error).toMatch(/not configured/i);
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

describe('webullOrderStatusBatch', () => {
  const cfg = () => Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  const openEnv = (cid: string, status: string) => ({
    client_order_id: cid,
    combo_order_id: `WB-${cid}`,
    orders: [{ client_order_id: cid, status, order_id: `WB-${cid}`, total_quantity: '2' }],
  });

  it('answers for many orders with ONE fetch per list, not one per order', async () => {
    // The whole point: the order-query endpoints allow 2 requests per 2
    // seconds, and the old per-order lookup spent two of them EACH.
    cfg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([openEnv('A', 'PENDING'), openEnv('B', 'PENDING'), openEnv('C', 'PENDING')]),
    } as Response);

    const out = await webullOrderStatusBatch('ACC1', ['A', 'B', 'C']);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.get('A')).toMatchObject({ ok: true, found: true, status: 'PENDING', brokerOrderId: 'WB-A' });
    expect(out.get('C')).toMatchObject({ ok: true, found: true, brokerOrderId: 'WB-C' });
  });

  it('falls through to history only for the orders open orders did not answer', async () => {
    cfg();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([openEnv('A', 'PENDING')]),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([openEnv('B', 'FILLED')]),
      } as Response);

    const out = await webullOrderStatusBatch('ACC1', ['A', 'B']);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/openapi/trade/order/history');
    expect(out.get('A')).toMatchObject({ status: 'PENDING' });
    expect(out.get('B')).toMatchObject({ status: 'FILLED' });
  });

  it('skips the history call entirely when open orders answered everything', async () => {
    cfg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([openEnv('A', 'PENDING')]),
    } as Response);

    await webullOrderStatusBatch('ACC1', ['A']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports an error — never "not found" — when open orders cannot be read', async () => {
    // found:false is positive evidence the order never landed, and a caller
    // acts on it by retiring the intent. A failed fetch must never look like
    // that.
    cfg();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ msg: 'upstream unavailable' }),
    } as Response);

    const out = await webullOrderStatusBatch('ACC1', ['A', 'B']);

    for (const id of ['A', 'B']) {
      expect(out.get(id)).toMatchObject({ ok: false, found: false });
      expect(out.get(id)!.error).toMatch(/upstream unavailable/i);
    }
  });

  it('keeps answers already resolved from open orders when history then fails', async () => {
    cfg();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([openEnv('A', 'PENDING')]),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => JSON.stringify({ msg: 'boom' }) } as Response);

    const out = await webullOrderStatusBatch('ACC1', ['A', 'B']);

    expect(out.get('A')).toMatchObject({ ok: true, found: true, status: 'PENDING' });
    expect(out.get('B')).toMatchObject({ ok: false, found: false });
  });

  it('reports found:false only when BOTH lists were read and neither knows the order', async () => {
    cfg();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '[]' } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '[]' } as Response);

    expect(await webullOrderStatusBatch('ACC1', ['GHOST'])).toEqual(new Map([['GHOST', { ok: true, found: false }]]));
  });

  it('spends nothing on an empty request, and reports unconfigured without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await webullOrderStatusBatch('ACC1', [])).toEqual(new Map());

    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const out = await webullOrderStatusBatch('ACC1', ['A']);
    expect(out.get('A')).toMatchObject({ ok: false, found: false, error: expect.stringMatching(/not configured/i) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('de-duplicates repeated ids rather than asking twice', async () => {
    cfg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([openEnv('A', 'PENDING')]),
    } as Response);

    const out = await webullOrderStatusBatch('ACC1', ['A', 'A', 'A']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(1);
  });

  it('surfaces every combo leg, exactly as the single-order lookup does', async () => {
    // A bracket arrives as sibling envelopes sharing combo_order_id; the batch
    // must not lose that by resolving orders one at a time.
    cfg();
    const leg = (cid: string, comboType: string, status: string) => ({
      client_order_id: cid,
      combo_order_id: 'WB-COMBO',
      combo_type: comboType,
      status,
      order_id: `WB-${cid}`,
      filled_quantity: '10',
      filled_price: '100',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([leg('CID-M', 'MASTER', 'FILLED'), leg('CID-SL', 'STOP_LOSS', 'CANCELLED')]),
    } as Response);

    const out = await webullOrderStatusBatch('ACC1', ['CID-M']);
    expect(out.get('CID-M')).toMatchObject({ status: 'FILLED' });
    expect(out.get('CID-M')!.legs).toHaveLength(2);
  });
});

describe('order-list pagination', () => {
  const cfg = () => Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  const env = (cid: string, status: string) => ({
    client_order_id: cid,
    combo_order_id: `WB-${cid}`,
    orders: [{ client_order_id: cid, status, order_id: `WB-${cid}`, total_quantity: '1' }],
  });
  const page = (envs: unknown[]) => ({ ok: true, status: 200, text: async () => JSON.stringify(envs) }) as Response;

  it('requests big pages (page_size) so a default-sized page cannot hide orders', async () => {
    cfg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([env('A', 'PENDING')]));
    await webullOrderStatus('ACC1', 'A');
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('page_size=100');
  });

  it('follows the client_order_id cursor across full pages until a short page', async () => {
    cfg();
    // Page 1: exactly page_size envelopes (full page → keep walking). The order
    // being asked about is only on page 2.
    const fullPage = Array.from({ length: 100 }, (_, i) => env(`OPEN-${i}`, 'PENDING'));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(fullPage))
      .mockResolvedValueOnce(page([env('DEEP', 'FILLED')]));

    const r = await webullOrderStatus('ACC1', 'DEEP');

    expect(r).toMatchObject({ ok: true, found: true, status: 'FILLED' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const url2 = String(fetchSpy.mock.calls[1][0]);
    expect(url2).toContain('last_client_order_id=OPEN-99');
  });

  it('stops (with page-1 data) when the server ignores the cursor and replays the same page', async () => {
    cfg();
    const fullPage = Array.from({ length: 100 }, (_, i) => env(`OPEN-${i}`, 'PENDING'));
    // Same first envelope on every call — a server that ignores the cursor.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(page(fullPage));

    const r = await webullOrderStatus('ACC1', 'OPEN-3');

    expect(r).toMatchObject({ ok: true, found: true });
    // 2 calls for open (page 1 + the replayed page that stops the walk) — never
    // the 20-page ceiling.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('fails the WHOLE lookup when a later page cannot be read (partial list must not mean "not found")', async () => {
    cfg();
    const fullPage = Array.from({ length: 100 }, (_, i) => env(`OPEN-${i}`, 'PENDING'));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(fullPage))
      .mockResolvedValue({ ok: false, status: 500, text: async () => JSON.stringify({ msg: 'boom' }) } as Response);

    const r = await webullOrderStatus('ACC1', 'NOT-ON-PAGE-1');
    expect(r.ok).toBe(false);
    expect(r.found).toBe(false);
    expect(r.error).toMatch(/boom/);
  });

  it('listWebullOpenOrders walks pages too, so a resting exit leg beyond page 1 is still seen', async () => {
    cfg();
    const fullPage = Array.from({ length: 100 }, (_, i) => env(`OPEN-${i}`, 'PENDING'));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(fullPage))
      .mockResolvedValueOnce(page([env('LAST', 'PENDING')]));

    const r = await listWebullOpenOrders('ACC1');
    expect(r.ok).toBe(true);
    expect(r.orders).toHaveLength(101);
    expect(r.orders.some((o) => o.clientOrderId === 'LAST')).toBe(true);
  });
});
