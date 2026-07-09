import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { createIntent, getIntent, transitionIntent } from '../src/db/orders';
import { addExit, createPosition, listPositions } from '../src/db/positions';
import { mapWebullStatus, reconcileAllWorking, reconcileIntent } from '../src/services/trading/reconcile';
import type { OrderIntent } from '../src/services/trading/guardrails';

const origWebull = { ...config.webull };
const CID = 'cc404a3544f74577a20839cf42c5892e';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM positions;',
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
      sourceIntentId: id, // provenance for execution-quality (slippage) tracking
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
    expect(pos.exits[0]).toMatchObject({ quantity: 1, exitPrice: 1.89, sourceIntentId: id });
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

describe('reconcileIntent — bracket exit leg (human-placed bracket)', () => {
  // Entry already filled and materialized into an open Position (mirrors what
  // an earlier reconcileIntent call would have produced) — awaiting its
  // STOP_LOSS/STOP_PROFIT exit leg.
  function bracketFilledWithOpenPosition(): { id: number; positionId: number } {
    const rec = createIntent(intent({ bracket: { takeProfitPrice: 2.5, stopLossPrice: 1.5 } }), CID);
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'MASTER-1' });
    transitionIntent(rec.id, 'filled', { detail: 'entry filled' });
    const pos = createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 1,
      entryPrice: 1.89,
      entryDate: '2026-06-01',
      sourceIntentId: rec.id,
    });
    return { id: rec.id, positionId: pos.id };
  }

  const masterLeg = {
    combo_type: 'MASTER',
    status: 'FILLED',
    client_order_id: CID,
    order_id: 'MASTER-1',
    filled_quantity: '1',
    filled_price: '1.89', // the ENTRY's fill price — must NOT leak into the exit
  };
  const bracketWorkingEnvelope = {
    client_order_id: CID,
    combo_order_id: 'MASTER-1',
    orders: [
      masterLeg,
      { combo_type: 'STOP_LOSS', status: 'WORKING', order_id: 'SL-1' },
      { combo_type: 'STOP_PROFIT', status: 'WORKING', order_id: 'TP-1' },
    ],
  };
  const bracketStopFilledEnvelope = {
    client_order_id: CID,
    combo_order_id: 'MASTER-1',
    orders: [
      masterLeg,
      { combo_type: 'STOP_LOSS', status: 'FILLED', order_id: 'SL-1', filled_quantity: '1', filled_price: '1.75' },
      { combo_type: 'STOP_PROFIT', status: 'CANCELLED', order_id: 'TP-1' },
    ],
  };
  const bracketBothFilledEnvelope = {
    client_order_id: CID,
    combo_order_id: 'MASTER-1',
    orders: [
      masterLeg,
      { combo_type: 'STOP_LOSS', status: 'FILLED', order_id: 'SL-1', filled_quantity: '1', filled_price: '1.75' },
      { combo_type: 'STOP_PROFIT', status: 'FILLED', order_id: 'TP-1', filled_quantity: '1', filled_price: '2.5' },
    ],
  };

  it('keeps polling a filled bracket whose exit leg is still working (does not short-circuit)', async () => {
    const { id } = bracketFilledWithOpenPosition();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([bracketWorkingEnvelope]))
      .mockResolvedValueOnce(okResp([bracketWorkingEnvelope]));
    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(fetchSpy).toHaveBeenCalled(); // NOT short-circuited despite intent.state === 'filled'
    expect(listPositions({ status: 'open' })).toHaveLength(1); // still open
  });

  it('records the exit once the STOP_LOSS leg reports FILLED, priced from the LEG (not the entry)', async () => {
    const { id, positionId } = bracketFilledWithOpenPosition();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp([bracketStopFilledEnvelope]));

    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: true });
    const pos = listPositions().find((p) => p.id === positionId)!;
    expect(pos.status).toBe('closed');
    expect(pos.exits).toHaveLength(1);
    expect(pos.exits[0]).toMatchObject({ quantity: 1, exitPrice: 1.75 }); // the STOP_LOSS leg's price
  });

  it('also records the exit when the STOP_PROFIT (take-profit) leg fills instead — symmetric handling', async () => {
    const { id, positionId } = bracketFilledWithOpenPosition();
    const targetFilledEnvelope = {
      client_order_id: CID,
      combo_order_id: 'MASTER-1',
      orders: [
        masterLeg,
        { combo_type: 'STOP_LOSS', status: 'CANCELLED', order_id: 'SL-1' },
        { combo_type: 'STOP_PROFIT', status: 'FILLED', order_id: 'TP-1', filled_quantity: '1', filled_price: '2.5' },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp([targetFilledEnvelope]));

    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: true });
    const pos = listPositions().find((p) => p.id === positionId)!;
    expect(pos.status).toBe('closed');
    expect(pos.exits[0]).toMatchObject({ quantity: 1, exitPrice: 2.5 }); // the STOP_PROFIT leg's price
  });

  it('leaves the position open (fails closed) when two exit legs both report FILLED — ambiguous', async () => {
    const { id } = bracketFilledWithOpenPosition();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResp([bracketBothFilledEnvelope]));
    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('stops polling once the position is already fully closed', async () => {
    const { id, positionId } = bracketFilledWithOpenPosition();
    addExit(positionId, { quantity: 1, exitPrice: 1.75, exitDate: '2026-06-05' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reconcileAllWorking includes a filled bracket with a still-open position', async () => {
    const { id } = bracketFilledWithOpenPosition();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([bracketWorkingEnvelope]));
    const r = await reconcileAllWorking('ACC1');
    expect(r.results.map((x) => x.id)).toContain(id);
    expect(fetchSpy).toHaveBeenCalled();
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
