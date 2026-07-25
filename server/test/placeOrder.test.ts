import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { placeOrder, placeConfirmation } from '../src/services/trading/placeOrder';
import { setTradingConfig } from '../src/db/trading';
import { getEvents, listIntents } from '../src/db/orders';
import type { OrderIntent } from '../src/services/trading/guardrails';
import * as providersModule from '../src/providers';

// placeOrder re-derives the fat-finger reference from a fresh stock quote
// (never the client's). Mock that source so it's deterministic and doesn't
// touch the Webull fetch mocks: every symbol resolves to $7 (matching the
// default intent's limit, so fat_finger passes on the happy path).
vi.mock('../src/services/quotes', () => ({
  resolveStockPrices: vi.fn(async (symbols: string[]) => {
    return new Map(symbols.map((s) => [s.toUpperCase(), { symbol: s.toUpperCase(), price: 7, stale: false, asOf: 0 }]));
  }),
}));

const origWebull = { ...config.webull };
const origPlace = config.trading.placeEnabled;

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM trading_config;',
  );
  config.trading.placeEnabled = true; // env master gate ON
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  setTradingConfig({ enabled: true }); // arm the guardrail
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
  symbol: 'NUVB',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 1,
  orderType: 'limit',
  limitPrice: 7,
  referencePrice: 7,
  ...over,
});
const okResp = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as Response;
const ok = () => placeConfirmation(intent()); // "BUY 1 NUVB"

describe('place order (live)', () => {
  it('refuses when TRADING_ENABLED is off — no intent, no broker call', async () => {
    config.trading.placeEnabled = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await placeOrder(intent(), 'ACC1', ok());
    expect(r).toMatchObject({ placed: false, reason: 'trading_disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listIntents()).toHaveLength(0);
  });

  it('refuses an unconfirmed order (no broker call)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await placeOrder(intent(), 'ACC1', 'nope');
    expect(r).toMatchObject({ placed: false, reason: 'not_confirmed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('places a single-leg OPTION order when guardrails pass (OPTION body to /place)', async () => {
    const opt = intent({
      symbol: 'NVDA',
      assetKind: 'option',
      optionType: 'call',
      strike: 200,
      expiration: '2026-12-19',
      quantity: 1,
      orderType: 'limit',
      limitPrice: 0.1, // notional 1 × 100 × $0.10 = $10 ≤ buying power $10.81
      referencePrice: 0.1,
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp({ order_id: 'WB-OPT-1' }));

    const r = await placeOrder(opt, 'ACC1', placeConfirmation(opt));
    expect(r).toMatchObject({ placed: true, reason: 'placed' });
    expect(r.broker?.orderId).toBe('WB-OPT-1');
    const placeBody = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
    expect(placeBody.new_orders[0]).toMatchObject({ instrument_type: 'OPTION', option_strategy: 'SINGLE' });
  });

  it('re-derives a single-leg OPTION fat-finger reference server-side (a spoofed client mark cannot defeat it)', async () => {
    // The current contract mark is $5, but the client sends referencePrice equal
    // to its absurd $0.10 limit (deviation 0 — would pass fat_finger). The server
    // must re-derive the reference from the chain and block.
    vi.spyOn(providersModule, 'getProvider').mockReturnValue({
      getOptionsChain: async () => ({ calls: [{ strike: 200, mark: 5, last: 5 }], puts: [] }),
    } as unknown as ReturnType<typeof providersModule.getProvider>);
    const opt = intent({
      symbol: 'NVDA',
      assetKind: 'option',
      optionType: 'call',
      strike: 200,
      expiration: '2026-12-19',
      quantity: 1,
      orderType: 'limit',
      limitPrice: 0.1,
      referencePrice: 0.1, // spoofed to equal the limit
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]));

    const r = await placeOrder(opt, 'ACC1', placeConfirmation(opt));
    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(r.guardrails?.checks.find((c) => c.rule === 'fat_finger')?.passed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('/order/place'), expect.anything());
  });

  it('blocks (and never calls the broker) when a guardrail fails — kill switch', async () => {
    setTradingConfig({ enabled: true, killSwitch: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([])); // balance + positions only

    const r = await placeOrder(intent(), 'ACC1', ok());
    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(r.guardrails?.checks.find((c) => c.rule === 'kill_switch')?.passed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no /place call
    expect(getEvents(r.intent!.id).map((e) => e.state)).toEqual(['draft', 'rejected']);
  });

  it('fails closed (account_error, no broker call) when the positions call fails — never sizes against an unknown position', async () => {
    // Regression (hardening audit): balance OK but positions FAILED must not be
    // treated as a flat account — a fabricated 0 would under-count a real
    // holding for the position_size cap.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance OK
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => JSON.stringify({ msg: 'down' }) } as Response); // positions FAIL

    const r = await placeOrder(intent(), 'ACC1', ok());
    expect(r).toMatchObject({ placed: false, reason: 'account_error' });
    expect(r.error).toMatch(/verify current positions/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // balance + positions, then STOP — no /place
  });

  it('re-derives the fat-finger reference server-side, so a spoofed client referencePrice cannot defeat it', async () => {
    // Regression (hardening audit): the client sends referencePrice == its own
    // absurd limit (client-side deviation 0), but the server re-derives the
    // reference from a fresh quote ($7 per the mock) — so an $80 limit is
    // 1043% off and fat_finger BLOCKS it, no broker call.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance
      .mockResolvedValueOnce(okResp([])); // positions
    const spoofed = intent({ limitPrice: 80, referencePrice: 80 });
    const r = await placeOrder(spoofed, 'ACC1', placeConfirmation(spoofed));
    expect(r).toMatchObject({ placed: false, reason: 'blocked' });
    expect(r.guardrails?.checks.find((c) => c.rule === 'fat_finger')?.passed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no /place
  });

  it('places a live order when all gates pass, recording the broker order id + full audit trail', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance
      .mockResolvedValueOnce(okResp([])) // positions
      .mockResolvedValueOnce(okResp({ order_id: 'WB-ORDER-1' })); // place

    const r = await placeOrder(intent(), 'ACC1', ok());
    expect(r).toMatchObject({ placed: true, reason: 'placed' });
    expect(r.broker?.orderId).toBe('WB-ORDER-1');
    expect(r.intent).toMatchObject({ state: 'acknowledged', brokerOrderId: 'WB-ORDER-1' });

    const [url, opts] = fetchSpy.mock.calls[2];
    expect(String(url)).toContain('/openapi/trade/order/place');
    expect((opts as RequestInit).method).toBe('POST');
    expect(getEvents(r.intent!.id).map((e) => e.state)).toEqual([
      'draft',
      'validated',
      'confirmed',
      'submitted',
      'acknowledged',
    ]);
  });

  it('is idempotent: a repeat /place with the same key never submits a second order', async () => {
    const key = 'idem-key-abc123';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // first call: balance, positions, place
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp({ order_id: 'WB-ORDER-1' }))
      // second call (same key): balance, positions — but NO place
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]));

    const first = await placeOrder(intent(), 'ACC1', ok(), key);
    expect(first).toMatchObject({ placed: true, reason: 'placed' });

    const second = await placeOrder(intent(), 'ACC1', ok(), key);
    expect(second).toMatchObject({ placed: false, reason: 'duplicate' });
    expect(second.intent?.id).toBe(first.intent?.id); // same intent row, not a new order

    const placeCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/order/place'));
    expect(placeCalls).toHaveLength(1); // exactly one real order across both requests
  });

  it('submits a permitted short (allowNakedShort) with side SHORT, not SELL', async () => {
    setTradingConfig({ enabled: true, allowNakedShort: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance
      .mockResolvedValueOnce(okResp([])) // positions — flat, so this sell opens a short
      .mockResolvedValueOnce(okResp({ order_id: 'WB-SHORT-1' })); // place

    const short = intent({ side: 'sell' });
    const r = await placeOrder(short, 'ACC1', placeConfirmation(short));

    expect(r).toMatchObject({ placed: true, reason: 'placed' });
    const placeBody = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
    expect(placeBody.new_orders[0].side).toBe('SHORT');
  });

  it('a sell that only reduces an existing long still submits SELL, not SHORT', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance
      .mockResolvedValueOnce(
        okResp([{ symbol: 'NUVB', quantity: '10', cost_price: '5', market_value: '70', asset_type: 'stock' }]),
      ) // positions — long 10, selling 1 only reduces it
      .mockResolvedValueOnce(okResp({ order_id: 'WB-CLOSE-1' })); // place

    const closeSome = intent({ side: 'sell', openClose: 'close' });
    const r = await placeOrder(closeSome, 'ACC1', placeConfirmation(closeSome));

    expect(r).toMatchObject({ placed: true, reason: 'placed' });
    const placeBody = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
    expect(placeBody.new_orders[0].side).toBe('SELL');
  });

  it('records a broker rejection without claiming a fill', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ msg: 'market closed' }),
      } as Response);

    const r = await placeOrder(intent(), 'ACC1', ok());
    expect(r).toMatchObject({ placed: false, reason: 'broker_rejected' });
    expect(r.broker?.error).toMatch(/market closed/i);
    expect(r.intent?.state).toBe('rejected');
    expect(getEvents(r.intent!.id).map((e) => e.state)).toEqual([
      'draft',
      'validated',
      'confirmed',
      'submitted',
      'rejected',
    ]);
  });
});
