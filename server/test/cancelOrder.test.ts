import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { createIntent, getIntent, transitionIntent } from '../src/db/orders';
import { cancelIntent } from '../src/services/trading/cancelOrder';
import type { OrderIntent } from '../src/services/trading/guardrails';

const origWebull = { ...config.webull };
const CID = 'cancel-cid-1';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM order_events; DELETE FROM order_intents;',
  );
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
});
afterEach(() => {
  Object.assign(config.webull, origWebull);
  vi.restoreAllMocks();
});

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

function placedIntentId(): number {
  const rec = createIntent(intent(), CID);
  transitionIntent(rec.id, 'validated');
  transitionIntent(rec.id, 'confirmed');
  transitionIntent(rec.id, 'submitted');
  transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'WB-CXL-1' });
  return rec.id;
}

const cancelledEnvelope = {
  client_order_id: CID,
  combo_order_id: 'WB-CXL-1',
  orders: [{ status: 'CANCELLED', order_id: 'WB-CXL-1', total_quantity: '1', filled_quantity: '0' }],
};

describe('cancelIntent', () => {
  it('refuses a terminal order without calling the broker', async () => {
    const id = placedIntentId();
    transitionIntent(id, 'filled', { detail: 'filled' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await cancelIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, requested: false, reason: 'not_open' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a broker rejection without changing state', async () => {
    const id = placedIntentId();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ msg: 'order not cancellable' }),
    } as Response);

    const r = await cancelIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, requested: false, reason: 'broker_rejected' });
    expect(r.error).toMatch(/not cancellable/i);
    expect(getIntent(id)?.state).toBe('acknowledged');
  });

  it('cancels, then reconciles to the cancelled terminal state', async () => {
    const id = placedIntentId();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp({ ok: true })) // POST /cancel accepted
      .mockResolvedValueOnce(okResp([])) // reconcile: open orders (none)
      .mockResolvedValueOnce(okResp([cancelledEnvelope])); // reconcile: history (cancelled)

    const r = await cancelIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, requested: true, reason: 'requested' });
    expect(r.intent?.state).toBe('cancelled');
    expect(getIntent(id)?.state).toBe('cancelled');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/openapi/trade/order/cancel');
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('404s on an unknown intent', async () => {
    const r = await cancelIntent(999, 'ACC1');
    expect(r).toMatchObject({ ok: false, requested: false, reason: 'not_found' });
  });
});
