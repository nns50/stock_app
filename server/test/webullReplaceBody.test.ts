import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../src/config';
import { webullReplaceOrders } from '../src/providers/webull/orders';

// These assert the HTTP BODY, not the patch objects handed to
// webullReplaceOrders.
//
// bracketResize.test.ts and liveEquityTimeExit.test.ts both pin the PATCH
// shape, and on 2026-09-04 deleting the two lines that copy `comboType` and
// `clientComboOrderId` into the request left all 77 of those green. A field
// the broker never receives is exactly the failure this repo keeps repeating —
// so the request itself needs its own consumer-side test.
const origWebull = { ...config.webull };
beforeEach(() => Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' }));
afterEach(() => {
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
});

const ok = () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });

async function bodyOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
  await fn();
  const call = spy.mock.calls.find((c) => String(c[0]).includes('/openapi/trade/order/replace'));
  expect(call, 'no /order/replace request was made').toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

describe('webullReplaceOrders — the request body', () => {
  it('puts combo_type on EACH modify entry', async () => {
    const body = await bodyOf(() =>
      webullReplaceOrders('ACC1', [
        { clientOrderId: 'TGT', quantity: 4, limitPrice: 110, comboType: 'STOP_PROFIT' },
        { clientOrderId: 'STP', quantity: 4, stopPrice: 96, comboType: 'STOP_LOSS' },
      ]),
    );
    expect(body.modify_orders).toEqual([
      { client_order_id: 'TGT', combo_type: 'STOP_PROFIT', quantity: '4', limit_price: '110' },
      { client_order_id: 'STP', combo_type: 'STOP_LOSS', quantity: '4', stop_price: '96' },
    ]);
  });

  // Shape #5, and the first drawn from the REPLACE endpoint's own documented
  // schema: reference/common-order-replace lists order_type as an accepted
  // modify_orders field and does NOT list combo_type. Since "the number of
  // take-profit orders and the number of stop-loss orders must be the same" is
  // a complaint about telling the legs apart, and both legs of a long bracket
  // are `sell`, order_type (LIMIT vs STOP_LOSS) is the documented thing that
  // separates them.
  it('sends order_type on each modify entry so the broker can classify the legs', async () => {
    const body = await bodyOf(() =>
      webullReplaceOrders('ACC1', [
        { clientOrderId: 'TGT', quantity: 4, limitPrice: 110, comboType: 'STOP_PROFIT', orderType: 'LIMIT' },
        { clientOrderId: 'STP', quantity: 4, stopPrice: 96, comboType: 'STOP_LOSS', orderType: 'STOP_LOSS_LIMIT' },
      ]),
    );
    expect(body.modify_orders).toEqual([
      { client_order_id: 'TGT', combo_type: 'STOP_PROFIT', order_type: 'LIMIT', quantity: '4', limit_price: '110' },
      {
        client_order_id: 'STP',
        combo_type: 'STOP_LOSS',
        order_type: 'STOP_LOSS_LIMIT',
        quantity: '4',
        stop_price: '96',
      },
    ]);
  });

  it('omits order_type entirely when the leg carried none', async () => {
    // Absent, not the string "undefined" — and never derived from the leg's
    // role, which would convert a STOP_LOSS_LIMIT into a plain STOP_LOSS while
    // claiming only to identify it.
    const body = await bodyOf(() =>
      webullReplaceOrders('ACC1', [{ clientOrderId: 'STP', quantity: 4, stopPrice: 96 }]),
    );
    expect(body.modify_orders).toEqual([{ client_order_id: 'STP', quantity: '4', stop_price: '96' }]);
  });

  it('puts client_combo_order_id at the REQUEST level, beside modify_orders', async () => {
    // Every documented combo request places it there — a sibling of the orders
    // array, never inside a leg.
    const body = await bodyOf(() =>
      webullReplaceOrders('ACC1', [{ clientOrderId: 'STP', quantity: 4, stopPrice: 96 }], 'COMBO-1'),
    );
    expect(body.client_combo_order_id).toBe('COMBO-1');
    expect(body.account_id).toBe('ACC1');
    expect((body.modify_orders as unknown[])[0]).not.toHaveProperty('client_combo_order_id');
  });

  it('OMITS client_combo_order_id entirely when none is known', async () => {
    // A bracket opened before the id was persisted must send the request
    // unchanged rather than an empty or invented group id.
    const body = await bodyOf(() =>
      webullReplaceOrders('ACC1', [{ clientOrderId: 'STP', quantity: 4, stopPrice: 96 }]),
    );
    expect('client_combo_order_id' in body).toBe(false);
  });

  it('omits combo_type when the leg was not classified', async () => {
    const body = await bodyOf(() => webullReplaceOrders('ACC1', [{ clientOrderId: 'X', stopPrice: 5 }]));
    expect((body.modify_orders as Record<string, unknown>[])[0]).not.toHaveProperty('combo_type');
  });
});
