import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { createIntent, getIntent, transitionIntent } from '../src/db/orders';
import { createPosition, listPositions } from '../src/db/positions';
import { mapWebullStatus, reconcileAllWorking, reconcileIntent } from '../src/services/trading/reconcile';
import type { OrderIntent } from '../src/services/trading/guardrails';

const origWebull = { ...config.webull };
const CID = 'cc404a3544f74577a20839cf42c5892e';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec('DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM positions;');
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
  limitPrice: 1.89,
  referencePrice: 1.89,
  ...over,
});
const okResp = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as Response;

// A live order that reached the broker (draft → … → acknowledged).
function placedIntentId(): number {
  const rec = createIntent(intent(), CID);
  transitionIntent(rec.id, 'validated');
  transitionIntent(rec.id, 'confirmed');
  transitionIntent(rec.id, 'submitted');
  transitionIntent(rec.id, 'acknowledged', { brokerOrderId: '8AIG1C8LCCE58QHNDSU5NHBP09' });
  return rec.id;
}

// One history envelope as Webull really returns it (see the live /order/history probe).
const filledEnvelope = {
  client_order_id: CID,
  combo_type: 'NORMAL',
  combo_order_id: '8AIG1C8LCCE58QHNDSU5NHBP09',
  orders: [
    {
      symbol: 'AMC',
      side: 'BUY',
      status: 'FILLED',
      client_order_id: CID,
      order_id: '8AIG1C8LCCE58QHNDSU5NHBP09',
      total_quantity: '1',
      filled_quantity: '1',
      filled_price: '1.890',
    },
  ],
};

describe('mapWebullStatus', () => {
  it('maps broker statuses to lifecycle states', () => {
    expect(mapWebullStatus('FILLED')).toBe('filled');
    expect(mapWebullStatus('partially_filled')).toBe('partially_filled');
    expect(mapWebullStatus('CANCELLED')).toBe('cancelled');
    expect(mapWebullStatus('EXPIRED')).toBe('expired');
    expect(mapWebullStatus('PENDING')).toBe('acknowledged');
    expect(mapWebullStatus('WAT')).toBeUndefined();
  });
});

describe('reconcileIntent', () => {
  it('advances an acknowledged order to filled from the broker history', async () => {
    const id = placedIntentId();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([])) // open orders: none
      .mockResolvedValueOnce(okResp([filledEnvelope])); // history: our fill

    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.intent?.state).toBe('filled');
    expect(r.broker).toMatchObject({ found: true, status: 'FILLED', filledQty: 1, filledPrice: 1.89 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The fill is in the audit trail.
    expect(getIntent(id)?.state).toBe('filled');
  });

  it('is a no-op when the order is not (yet) at the broker', async () => {
    const id = placedIntentId();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp([])).mockResolvedValueOnce(okResp([]));
    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(r.broker?.found).toBe(false);
    expect(r.intent?.state).toBe('acknowledged');
  });

  it('does not touch the broker once the intent is terminal', async () => {
    const id = placedIntentId();
    transitionIntent(id, 'filled', { detail: 'already filled' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records a filled OPEN order as a tracked Position (buy → long, at the fill price)', async () => {
    const id = placedIntentId(); // stock BUY, open
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filledEnvelope]));

    await reconcileIntent(id, 'ACC1');
    const positions = listPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 1,
      entryPrice: 1.89,
    });
  });

  it('does not record a position for a CLOSE fill (closes reduce, not open)', async () => {
    const rec = createIntent(intent({ openClose: 'close' }), CID);
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filledEnvelope]));

    await reconcileIntent(rec.id, 'ACC1');
    expect(listPositions()).toHaveLength(0);
  });

  // Helper: a CLOSE order (sell-to-close) walked to acknowledged.
  function closeOrder(over: Partial<OrderIntent>, cid: string): number {
    const rec = createIntent(intent({ side: 'sell', openClose: 'close', ...over }), cid);
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged', { brokerOrderId: '8AIG1C8LCCE58QHNDSU5NHBP09' });
    return rec.id;
  }

  it('records a filled CLOSE as an exit against the matching open position, closing it', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 1,
      entryPrice: 1.5,
      entryDate: '2026-06-01',
    });
    const id = closeOrder({}, CID);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filledEnvelope]));

    await reconcileIntent(id, 'ACC1');
    const pos = listPositions({ symbol: 'AMC' })[0];
    expect(pos.exits).toHaveLength(1);
    expect(pos.exits[0]).toMatchObject({ quantity: 1, exitPrice: 1.89 });
    expect(pos.status).toBe('closed'); // fully exited
    expect(pos.remainingQuantity).toBe(0);
  });

  it('splits a CLOSE across open lots oldest-first (FIFO)', async () => {
    const older = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 1,
      entryPrice: 1.5,
      entryDate: '2026-06-01',
    });
    const newer = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 2,
      entryPrice: 1.7,
      entryDate: '2026-06-10',
    });
    const filled2 = {
      ...filledEnvelope,
      orders: [{ ...filledEnvelope.orders[0], total_quantity: '2', filled_quantity: '2' }],
    };
    const id = closeOrder({ quantity: 2 }, CID);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filled2]));

    await reconcileIntent(id, 'ACC1');
    const byId = (pid: number) => listPositions({ symbol: 'AMC' }).find((p) => p.id === pid)!;
    expect(byId(older.id).status).toBe('closed'); // oldest fully closed first
    expect(byId(newer.id).remainingQuantity).toBe(1); // newer partially closed
    expect(byId(newer.id).exits).toHaveLength(1);
  });

  it('does not record an exit when the close does not match an open position (wrong side)', async () => {
    // A short position can't be closed by a sell-to-close (that needs a buy).
    const short = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'short',
      quantity: 1,
      entryPrice: 1.5,
      entryDate: '2026-06-01',
    });
    const id = closeOrder({}, CID);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filledEnvelope]));

    await reconcileIntent(id, 'ACC1');
    expect(listPositions({ symbol: 'AMC' }).find((p) => p.id === short.id)!.exits).toHaveLength(0);
  });
});

describe('reconcileAllWorking', () => {
  // A live order that reached the broker, under a distinct client id.
  const working = (cid: string): number => {
    const rec = createIntent(intent(), cid);
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged', { brokerOrderId: `WB-${cid}` });
    return rec.id;
  };

  it('reconciles every working order and skips terminal / never-placed ones', async () => {
    const a = working('cid-a');
    const b = working('cid-b');
    const term = working('cid-c');
    transitionIntent(term, 'filled', { detail: 'already done' }); // terminal → skipped
    createIntent(intent(), 'cid-draft'); // never reached the broker → skipped

    // Broker finds nothing for either working order → both no-op (2 pulls each).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp([]));

    const r = await reconcileAllWorking('ACC1');
    expect(r).toMatchObject({ ok: true, reconciled: 2, changed: 0 });
    expect(r.results.map((x) => x.id).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    expect(fetchSpy).toHaveBeenCalledTimes(4); // open + history, per working order
    expect(getIntent(term)?.state).toBe('filled'); // untouched
  });

  it('counts the orders it advanced (one fills, one stays working)', async () => {
    const filledId = working(CID); // created first → lower id
    working('cid-still-open'); // created second → higher id → reconciled first (newest-first)
    // Each reconcile pulls open-orders then history. The still-open one finds
    // nothing; our CID order's history returns the fill.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([])) // still-open: open
      .mockResolvedValueOnce(okResp([])) // still-open: history
      .mockResolvedValueOnce(okResp([])) // CID: open
      .mockResolvedValueOnce(okResp([filledEnvelope])); // CID: history → fill

    const r = await reconcileAllWorking('ACC1');
    expect(r).toMatchObject({ ok: true, reconciled: 2, changed: 1 });
    expect(getIntent(filledId)?.state).toBe('filled');
  });
});
