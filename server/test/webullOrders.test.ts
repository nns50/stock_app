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
  committedProtectiveQuantity,
  buildStandaloneBracketRequest,
  protectiveBracketIntent,
  webullPlaceStandaloneBracket,
  webullOrderDetail,
  parseBrokerOptionFills,
  parseBrokerEquityFills,
  isOptionOrder,
} from '../src/providers/webull/orders';
import type { WebullOpenOrder } from '../src/providers/webull/orders';
import { decideExitCorrection } from '../src/services/exitPriceBackfill';
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

  // An options order names the UNDERLYING as its symbol, so a working close on
  // an MRNA call is, by symbol and side, a resting sell on MRNA shares. The
  // stock sleeve's exit logic can only tell them apart if the parse keeps the
  // instrument type (2026-09-23).
  it("keeps each order's instrument type, off the order or its envelope", () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const envelopes = [
      {
        client_order_id: 'CID-OPT',
        orders: [
          {
            client_order_id: 'CID-OPT',
            symbol: 'MRNA',
            side: 'SELL',
            status: 'SUBMITTED',
            order_type: 'LIMIT',
            combo_type: 'NORMAL',
            instrument_type: 'OPTION',
            legs: [{ symbol: 'MRNA', option_type: 'CALL', strike_price: '195', option_expire_date: '2026-09-25' }],
          },
        ],
      },
      {
        client_order_id: 'CID-SL',
        combo_order_id: 'WB-COMBO',
        combo_type: 'STOP_LOSS',
        instrument_type: 'EQUITY',
        orders: [{ client_order_id: 'CID-SL', symbol: 'MRNA', side: 'SELL', status: 'SUBMITTED' }],
      },
      { client_order_id: 'CID-BARE', orders: [{ client_order_id: 'CID-BARE', symbol: 'MRNA', side: 'SELL' }] },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(envelopes),
    } as Response);

    return listWebullOpenOrders('ACC1').then((r) => {
      const byId = Object.fromEntries(r.orders.map((o) => [o.clientOrderId, o]));
      expect(byId['CID-OPT'].instrumentType).toBe('OPTION');
      expect(byId['CID-SL'].instrumentType).toBe('EQUITY'); // from the envelope
      expect(byId['CID-BARE'].instrumentType).toBeUndefined();
      expect(isOptionOrder(byId['CID-OPT'])).toBe(true);
      expect(isOptionOrder(byId['CID-SL'])).toBe(false);
      // Unreadable is NOT an option: it stays a possible stock leg, fail-closed.
      expect(isOptionOrder(byId['CID-BARE'])).toBe(false);
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

  // 2026-09-23: two consecutive history pages both carried HOOD's bracket, so
  // its one filled exit leg was read twice and the exit correction refused it
  // as "2 filled exit legs". Same for MRNA's.
  it('reads an order repeated across overlapping pages once, taking the later copy', async () => {
    cfg();
    const leg = (cid: string, comboType: string, status: string, filledQty: string, filledPrice?: string) => ({
      client_order_id: cid,
      combo_order_id: 'WB-HOOD',
      combo_type: comboType,
      status,
      order_type: comboType === 'STOP_LOSS' ? 'STOP_LOSS' : 'LIMIT',
      filled_quantity: filledQty,
      ...(filledPrice === undefined ? {} : { filled_price: filledPrice }),
    });
    const bracket = (target: 'WORKING' | 'FILLED') => [
      leg('HOOD-M', 'MASTER', 'FILLED', '179', '115.26'),
      target === 'FILLED'
        ? leg('HOOD-TP', 'STOP_PROFIT', 'FILLED', '179', '117.56')
        : leg('HOOD-TP', 'STOP_PROFIT', 'WORKING', '0'),
      leg('HOOD-SL', 'STOP_LOSS', 'CANCELLED', '0'),
    ];
    const fillers = Array.from({ length: 97 }, (_, i) => env(`OLD-${i}`, 'FILLED'));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([...fillers, ...bracket('WORKING')]))
      .mockResolvedValueOnce(page([...bracket('FILLED'), env('NEWER', 'FILLED')]));

    const r = await webullOrderStatus('ACC1', 'HOOD-M');

    expect(r.legs).toHaveLength(3);
    expect(r.legs!.find((l) => l.comboType === 'STOP_PROFIT')).toMatchObject({ status: 'FILLED', filledPrice: 117.56 });
    // The consumer: one filled exit leg, so the booked quote is corrected to it.
    const exit = {
      exitId: 1,
      positionId: 650,
      symbol: 'HOOD',
      quantity: 179,
      exitPrice: 117.5999,
      exitDate: '2026-09-18',
      exitReason: 'target' as const,
    };
    expect(decideExitCorrection(exit, r.legs!)).toMatchObject({
      action: 'correct',
      realPrice: 117.56,
      reason: 'target',
    });
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

// ---------------------------------------------------------------------------
// committedProtectiveQuantity — the broker's real bound on a protective order.
//
// Measured 2026-09-08: a 1-share standalone bracket on FCX was refused as a
// position reversal while 38 shares were held, because a full-size bracket was
// already resting. `held` was never the bound; `held - committed` is. Both
// counting rules below come from that same live book, and getting either
// backwards submits an order the broker refuses — or, in the unsafe direction,
// one it accepts as a short.
// ---------------------------------------------------------------------------
describe('committedProtectiveQuantity', () => {
  const leg = (o: Partial<WebullOpenOrder>): WebullOpenOrder => ({
    symbol: 'FCX',
    side: 'sell',
    status: 'SUBMITTED',
    quantity: 38,
    ...o,
  });

  it('counts an OCO pair ONCE — the max leg, never the sum', () => {
    // FCX rested a 38-share stop and a 38-share target over 38 held, and the
    // broker accepted that at entry. Summing would say 76 and conclude the
    // account was already short.
    const orders = [
      leg({ comboOrderId: 'G1', comboType: 'STOP_LOSS', orderType: 'STOP_LOSS' }),
      leg({ comboOrderId: 'G1', comboType: 'STOP_PROFIT', orderType: 'LIMIT' }),
    ];
    expect(committedProtectiveQuantity(orders, 'FCX', 'sell')).toBe(38);
  });

  it('SUMS across distinct combo groups — that is what refused the test order', () => {
    const orders = [
      leg({ comboOrderId: 'G1', quantity: 19 }),
      leg({ comboOrderId: 'G1', quantity: 19 }),
      leg({ comboOrderId: 'G2', quantity: 19 }),
      leg({ comboOrderId: 'G2', quantity: 19 }),
    ];
    // The two-lot design over 38 held: exactly 38, with no headroom at all.
    expect(committedProtectiveQuantity(orders, 'FCX', 'sell')).toBe(38);
  });

  it('treats each leg with no combo id as its own group', () => {
    const orders = [leg({ quantity: 5 }), leg({ quantity: 7 })];
    expect(committedProtectiveQuantity(orders, 'FCX', 'sell')).toBe(12);
  });

  it('does not count a sell on an OPTION contract as shares committed', () => {
    // The options sleeve's working close on an FCX call rests as a SELL on
    // "FCX". It commits contracts, not shares (2026-09-23).
    const orders = [
      leg({ comboOrderId: 'G1', quantity: 38 }),
      leg({ comboType: 'NORMAL', orderType: 'LIMIT', quantity: 3, instrumentType: 'OPTION' }),
    ];
    expect(committedProtectiveQuantity(orders, 'FCX', 'sell')).toBe(38);
  });

  it('ignores the filled MASTER entry, other symbols, and the opposite side', () => {
    const orders = [
      leg({ side: 'buy', status: 'FILLED', comboOrderId: 'G1', comboType: 'MASTER' }),
      leg({ symbol: 'SMCI', comboOrderId: 'G9', quantity: 100 }),
      leg({ side: 'buy', comboOrderId: 'G8', quantity: 100 }),
      leg({ comboOrderId: 'G1', quantity: 38 }),
    ];
    expect(committedProtectiveQuantity(orders, 'FCX', 'sell')).toBe(38);
  });

  it('ignores every terminal status, so a cancelled bracket frees its quantity', () => {
    const orders = [
      leg({ comboOrderId: 'G1', status: 'CANCELLED' }),
      leg({ comboOrderId: 'G2', status: 'REJECTED' }),
      leg({ comboOrderId: 'G3', status: 'EXPIRED' }),
    ];
    expect(committedProtectiveQuantity(orders, 'FCX', 'sell')).toBe(0);
  });

  it('returns null rather than guessing LOW when a resting leg has no quantity', () => {
    // Guessing low is the direction that submits a reversing order, so this
    // must fail closed and the caller must refuse.
    expect(committedProtectiveQuantity([leg({ quantity: undefined })], 'FCX', 'sell')).toBeNull();
  });

  it('is case- and whitespace-insensitive about the symbol', () => {
    expect(committedProtectiveQuantity([leg({ symbol: 'fcx' })], '  fcx  ', 'sell')).toBe(38);
  });
});

// ---------------------------------------------------------------------------
// A protective bracket's side, on the WIRE (2026-09-23).
//
// buildStandaloneBracketRequest takes the position's ENTRY side and bracketExit
// flips it, so the legs rest on the closing side. The automatic re-arm passed
// the closing side instead and every leg came out inverted: for eleven days a
// "protective" re-arm of a long was a BUY stop plus a BUY take-profit limit.
// These pin the only thing that matters — what the broker receives.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A standalone bracket is a PLACEMENT, and a placement is never retried
// (2026-09-23, from the #637 review). The call omitted nonIdempotent, so a lost
// response re-sent the same body and the caller saw the retry's answer — most
// likely a refusal of the duplicate ids, which reads as a known rejection
// instead of an unanswered placement that may be resting.
// ---------------------------------------------------------------------------
describe('webullPlaceStandaloneBracket', () => {
  const place = () => webullPlaceStandaloneBracket('ACC1', protectiveBracketIntent('AAPL', 'long', 7), 110, 95);

  it('sends a lost response ONCE and reports it unanswered, not refused', async () => {
    // The failure it replaces: the first POST lands but its answer is lost; the
    // retry of the same body is refused as a duplicate, and that refusal is
    // what the caller used to see.
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      .mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => JSON.stringify({ msg: 'duplicate client_order_id' }),
      } as Response);

    const r = await place();

    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, ambiguous: true });
    expect(r.error).not.toMatch(/duplicate/);
  });

  it('does not retry a 429 either: it can post-date acceptance', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => JSON.stringify({ msg: 'too many requests' }),
    } as Response);

    const r = await place();

    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, ambiguous: true });
  });
});

describe('protectiveBracketIntent', () => {
  const wire = (positionSide: 'long' | 'short', target: number | undefined, stop: number | undefined) =>
    buildStandaloneBracketRequest(protectiveBracketIntent(' aapl ', positionSide, 7), target, stop)!.new_orders.map(
      (o) => ({ combo: o.combo_type, side: o.side, type: o.order_type, qty: o.quantity, symbol: o.symbol }),
    );

  it('protects a LONG with SELL legs — take-profit and stop both close it', () => {
    expect(wire('long', 110, 95)).toEqual([
      { combo: 'STOP_PROFIT', side: 'SELL', type: 'LIMIT', qty: '7', symbol: 'AAPL' },
      { combo: 'STOP_LOSS', side: 'SELL', type: 'STOP_LOSS', qty: '7', symbol: 'AAPL' },
    ]);
  });

  it('protects a SHORT with BUY legs', () => {
    expect(wire('short', 90, 105).map((l) => l.side)).toEqual(['BUY', 'BUY']);
  });

  it('is a CLOSE, never an opening order, and carries no MASTER', () => {
    const i = protectiveBracketIntent('AAPL', 'long', 7);
    expect(i).toMatchObject({ openClose: 'close', assetKind: 'stock', side: 'buy' });
    const req = buildStandaloneBracketRequest(i, 110, 95)!;
    expect(req.new_orders.some((o) => o.combo_type === 'MASTER')).toBe(false);
  });

  it('the inverted intent the re-arm used to pass really does produce BUY legs under a long', () => {
    // Kept as the regression's own witness: side 'sell' reads like "sell to
    // protect a long", and it is the one input that must never reach here.
    const inverted: OrderIntent = { ...protectiveBracketIntent('AAPL', 'long', 7), side: 'sell' };
    expect(buildStandaloneBracketRequest(inverted, 110, 95)!.new_orders.map((o) => o.side)).toEqual(['BUY', 'BUY']);
  });
});

// ---------------------------------------------------------------------------
// Order Detail by client_order_id (2026-09-23).
//
// Webull's reference says both order LISTS "may not return the most recent
// order data in real time due to processing delays" and names Order Detail by
// client_order_id as the read to trust. SHOP's 2026-09-22 close never appeared
// in either list; this is the read that finds it. Contract from Webull's SDK:
// GET /openapi/trade/order/detail?account_id=…&client_order_id=….
// ---------------------------------------------------------------------------
// The shape the broker's order history returned for the app's own NVDA close
// on 2026-09-21: a single-leg OPTION order names its contract only on the leg.
describe('parseBrokerOptionFills', () => {
  const nvdaClose = {
    client_order_id: 'CID-NVDA',
    combo_type: 'NORMAL',
    combo_order_id: 'COMBO-1',
    orders: [
      {
        client_order_id: 'CID-NVDA',
        symbol: 'NVDA',
        side: 'SELL',
        status: 'FILLED',
        instrument_type: 'OPTION',
        option_strategy: 'SINGLE',
        position_intent: 'SELL_TO_CLOSE',
        total_quantity: '6',
        filled_quantity: '6',
        filled_price: '0.25',
        filled_time: '1789999401426',
        filled_time_at: '2026-09-21T14:03:21.426Z',
        legs: [
          {
            id: 'L1',
            quantity: '6',
            side: 'SELL',
            symbol: 'NVDA',
            option_type: 'CALL',
            option_expire_date: '2026-09-21',
            strike_price: '225.00',
          },
        ],
      },
    ],
  };

  it('reads the contract off the leg and the fill off the order', () => {
    expect(parseBrokerOptionFills([nvdaClose])).toEqual([
      {
        clientOrderId: 'CID-NVDA',
        side: 'SELL',
        positionIntent: 'SELL_TO_CLOSE',
        underlying: 'NVDA',
        optionType: 'call',
        strike: 225,
        expiration: '2026-09-21',
        filledQty: 6,
        filledPrice: 0.25,
        filledAt: 1789999401426,
      },
    ]);
  });

  it('falls back to filled_time_at when the millisecond field is absent', () => {
    const o = { ...nvdaClose.orders[0], filled_time: undefined };
    const [fill] = parseBrokerOptionFills([{ ...nvdaClose, orders: [o] }]);
    expect(fill.filledAt).toBe(Date.parse('2026-09-21T14:03:21.426Z'));
  });

  it('skips what cannot be a single-leg options fill', () => {
    const base = nvdaClose.orders[0];
    const envelopes = [
      // an equity order
      { ...nvdaClose, orders: [{ ...base, instrument_type: 'EQUITY' }] },
      // nothing filled
      { ...nvdaClose, orders: [{ ...base, status: 'CANCELLED', filled_quantity: '0', filled_price: '0' }] },
      // a spread: two legs, no per-leg fill
      { ...nvdaClose, orders: [{ ...base, legs: [base.legs[0], { ...base.legs[0], strike_price: '230.00' }] }] },
      // no parseable contract
      { ...nvdaClose, orders: [{ ...base, legs: [{ ...base.legs[0], option_expire_date: 'soon' }] }] },
    ];
    expect(parseBrokerOptionFills(envelopes)).toEqual([]);
  });

  it('keeps a partial fill that was later cancelled: those contracts did trade', () => {
    const o = { ...nvdaClose.orders[0], status: 'CANCELLED', filled_quantity: '2' };
    expect(parseBrokerOptionFills([{ ...nvdaClose, orders: [o] }])).toMatchObject([{ filledQty: 2 }]);
  });
});

describe('webullOrderDetail', () => {
  const cfg = () => Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  const reply = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;
  const shopClose = {
    client_order_id: 'CID-SHOP',
    combo_order_id: '80HAQQC9TKE99E2ADV2CQPD45B',
    orders: [
      {
        client_order_id: 'CID-SHOP',
        order_id: '80HAQQC9TKE99E2ADV2CQPD45B',
        status: 'FILLED',
        filled_quantity: '91',
        total_quantity: '91',
        filled_price: '148.31',
      },
    ],
  };

  it('asks the detail endpoint for ONE order, by account and client order id', async () => {
    cfg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(shopClose));
    await webullOrderDetail('ACC1', 'CID-SHOP');
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('/openapi/trade/order/detail');
    expect(url).toContain('account_id=ACC1');
    expect(url).toContain('client_order_id=CID-SHOP');
  });

  it('reads an envelope the way a list entry is read', async () => {
    cfg();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(shopClose));
    expect(await webullOrderDetail('ACC1', 'CID-SHOP')).toMatchObject({
      ok: true,
      found: true,
      status: 'FILLED',
      filledQty: 91,
      filledPrice: 148.31,
      brokerOrderId: '80HAQQC9TKE99E2ADV2CQPD45B',
    });
  });

  it('accepts the same envelope inside an array', async () => {
    cfg();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([shopClose]));
    expect(await webullOrderDetail('ACC1', 'CID-SHOP')).toMatchObject({ found: true, status: 'FILLED' });
  });

  it('reads a reply that does not name our order as NOT FOUND — never as a guess — and keeps it for the journal', async () => {
    cfg();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ something: 'else' }));
    const r = await webullOrderDetail('ACC1', 'CID-SHOP');
    expect(r).toMatchObject({ ok: true, found: false });
    expect(r.raw).toEqual({ something: 'else' });
    expect(r.status).toBeUndefined();
  });

  it('a failed read is "could not ask", not "not found"', async () => {
    cfg();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ msg: 'boom' }, 500));
    expect(await webullOrderDetail('ACC1', 'CID-SHOP')).toMatchObject({ ok: false, found: false, error: 'boom' });
  });
});

describe('parseBrokerEquityFills', () => {
  // The shapes the history returned on 2026-09-21: a plain sell (SMCI's
  // stagnation close), a bracket's filled stop leg (COIN), its cancelled
  // sibling, and an option, each its own envelope with combo_type on it.
  const env = (combo: string, order: Record<string, unknown>) => ({
    client_order_id: order.client_order_id,
    combo_type: combo,
    combo_order_id: 'C',
    orders: [order],
  });
  const smci = env('NORMAL', {
    client_order_id: 'f2b2e47c',
    symbol: 'SMCI',
    side: 'SELL',
    status: 'FILLED',
    instrument_type: 'EQUITY',
    filled_quantity: '373',
    filled_price: '40.90',
    filled_time: '1790005419217',
    filled_time_at: '2026-09-21T15:43:39.217Z',
  });
  const coinStop = env('STOP_LOSS', {
    client_order_id: '8db1d316',
    symbol: 'COIN',
    side: 'SELL',
    status: 'FILLED',
    instrument_type: 'EQUITY',
    order_type: 'STOP_LOSS',
    filled_quantity: '161',
    filled_price: '204.37',
    filled_time_at: '2026-09-21T13:41:48.045Z',
  });
  const coinTarget = env('STOP_PROFIT', {
    client_order_id: 'caec553a',
    symbol: 'COIN',
    side: 'SELL',
    status: 'CANCELLED',
    instrument_type: 'EQUITY',
    filled_quantity: '0',
  });
  const option = env('NORMAL', {
    client_order_id: 'o',
    symbol: 'NVDA',
    side: 'SELL',
    status: 'FILLED',
    instrument_type: 'OPTION',
    filled_quantity: '6',
    filled_price: '0.25',
    filled_time: '1789999401426',
  });

  it('reads every filled stock order, with its combo type and time, and skips the rest', () => {
    expect(parseBrokerEquityFills([smci, coinStop, coinTarget, option])).toEqual([
      {
        clientOrderId: 'f2b2e47c',
        comboType: 'NORMAL',
        orderType: null,
        side: 'SELL',
        symbol: 'SMCI',
        filledQty: 373,
        filledPrice: 40.9,
        filledAt: 1790005419217,
      },
      {
        clientOrderId: '8db1d316',
        comboType: 'STOP_LOSS',
        orderType: 'STOP_LOSS',
        side: 'SELL',
        symbol: 'COIN',
        filledQty: 161,
        filledPrice: 204.37,
        // No epoch field: the ISO one is read instead.
        filledAt: Date.parse('2026-09-21T13:41:48.045Z'),
      },
    ]);
  });
});
