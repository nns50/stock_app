import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { advanceMaterialized, createIntent, getEvents, getIntent, transitionIntent } from '../src/db/orders';
import { addExit, createPosition, listPositions } from '../src/db/positions';
import { recordLiveOrder } from '../src/db/autotradeLiveOrders';
import { recordLiveOptionsEntryOrder } from '../src/db/autotradeLiveOptionsOrders';
import { canStillFill, mapWebullStatus, reconcileAllWorking, reconcileIntent } from '../src/services/trading/reconcile';
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

  it('defers entirely to autotrade for an autotrade-owned intent — no broker call, no state transition, no Position', async () => {
    // Regression: order_intents has no "who placed this" column, so this
    // generic reconcile used to be reachable for an autotrade-placed order
    // too. If it observed the fill first, it transitioned the intent to the
    // TERMINAL 'filled' state and recorded a plain ['live']-tagged Position —
    // permanently locking autotrade's own reconcile out (its own
    // !isTerminal(intent.state) guard) and leaving real, autotrade-opened
    // capital invisible to isAutotradePosition() forever. Confirmed via a
    // real user report (a live position that was genuinely autotrade-placed
    // never showing on the Auto page).
    const id = placedIntentId();
    recordLiveOrder({
      intentId: id,
      symbol: 'AMC',
      stopPrice: 1.7,
      targetPrice: 2.2,
      riskAmount: 20,
      riskProfile: 'MODERATE',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const r = await reconcileIntent(id, 'ACC1');

    expect(r).toEqual({ ok: true, changed: false, intent: expect.objectContaining({ id, state: 'acknowledged' }) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getIntent(id)?.state).toBe('acknowledged'); // untouched, not flipped to filled
    expect(listPositions()).toHaveLength(0); // no plain ['live']-tagged Position recorded
  });

  it('also defers for an autotrade LIVE OPTIONS-owned intent — same race, separate side table', async () => {
    // The options counterpart of the test above: liveOptionsExecute.ts places
    // its own live orders into this SAME shared order_intents table, tracked
    // via the PARALLEL db/autotradeLiveOptionsOrders.ts side table — equally
    // exposed to the same race, and with no tag-based healing backstop of its
    // own (autotrade_live_options_positions has no tags column at all), so
    // preventing this from ever happening is the only guard for it.
    const rec = createIntent(
      intent({ assetKind: 'option', optionType: 'call', strike: 5, expiration: '2026-08-21' }),
      'cid-options-auto',
    );
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'WB-OPT-1' });
    recordLiveOptionsEntryOrder({
      intentId: rec.id,
      symbol: 'AMC',
      kind: 'single_leg',
      side: 'call',
      contractSymbol: 'AMC260821C00005000',
      strike: 5,
      expiration: '2026-08-21',
      riskAmount: 20,
      riskProfile: 'MODERATE',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const r = await reconcileIntent(rec.id, 'ACC1');

    expect(r).toEqual({
      ok: true,
      changed: false,
      intent: expect.objectContaining({ id: rec.id, state: 'acknowledged' }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getIntent(rec.id)?.state).toBe('acknowledged');
    expect(listPositions()).toHaveLength(0);
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

describe('unrecognized broker status', () => {
  const envelope = (over: Record<string, unknown>) => ({
    client_order_id: CID,
    combo_order_id: '8AIG1C8LCCE58QHNDSU5NHBP09',
    orders: [{ client_order_id: CID, symbol: 'AMC', side: 'BUY', ...over }],
  });
  const pull = (env: unknown) =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([env]));

  it('books a fill reported alongside a status the mapper does not know', async () => {
    // The label and the fill are separate facts. This used to hit the early
    // return and do nothing at all — real shares, dropped in silence.
    const id = placedIntentId(); // quantity 1
    pull(envelope({ status: 'DONE_FOR_DAY', filled_quantity: '1', filled_price: '1.90' }));

    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBe(1);
    const positions = listPositions({ status: 'open' });
    expect(positions).toHaveLength(1);
    expect(positions[0].entryPrice).toBeCloseTo(1.9);
    // The lifecycle is deliberately NOT moved — we don't know what to call it.
    expect(getIntent(id)?.state).toBe('acknowledged');
    expect(getEvents(id).some((e) => e.detail?.includes('unrecognized status "DONE_FOR_DAY"'))).toBe(true);
  });

  it('notes the unrecognized status once, not on every poll', async () => {
    const id = placedIntentId();
    for (let i = 0; i < 3; i++) {
      pull(envelope({ status: 'DONE_FOR_DAY' }));
      await reconcileIntent(id, 'ACC1');
      vi.restoreAllMocks();
    }
    const notes = getEvents(id).filter((e) => e.detail?.includes('unrecognized status'));
    expect(notes).toHaveLength(1);
  });

  it('books nothing when an unrecognized status reports no fill', async () => {
    const id = placedIntentId();
    pull(envelope({ status: 'SOMETHING_NEW' }));
    const r = await reconcileIntent(id, 'ACC1');
    expect(r.materialized ?? 0).toBe(0);
    expect(listPositions({ status: 'open' })).toHaveLength(0);
    expect(getIntent(id)?.state).toBe('acknowledged'); // untouched
  });
});

describe('canStillFill', () => {
  it('treats an unknown or missing status as able to fill', () => {
    expect(canStillFill(undefined)).toBe(true);
    expect(canStillFill('SOMETHING_NEW')).toBe(true);
  });

  it('agrees with mapWebullStatus on every status it maps', () => {
    // The point of deriving one from the other: they cannot drift again.
    for (const s of ['FILLED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'FAILED']) {
      expect(canStillFill(s), s).toBe(false);
    }
    for (const s of ['PENDING', 'WORKING', 'QUEUED', 'NEW', 'ACCEPTED', 'PARTIAL_FILLED']) {
      expect(canStillFill(s), s).toBe(true);
    }
  });

  it('covers the broker-terminal statuses that have no lifecycle equivalent', () => {
    // These were terminal in liveExecute's own list and unmapped here, so the
    // same order read as "gone" to the bracket scan and "unknown" to reconcile.
    expect(mapWebullStatus('DELETED')).toBeUndefined();
    expect(canStillFill('DELETED')).toBe(false);
    expect(canStillFill('INACTIVE')).toBe(false);
    expect(canStillFill('inactive')).toBe(false); // case-insensitive
  });
});

describe('broker quantity drift', () => {
  const workingEnvelope = (over: Record<string, unknown>) => ({
    client_order_id: CID,
    combo_order_id: '8AIG1C8LCCE58QHNDSU5NHBP09',
    orders: [{ client_order_id: CID, symbol: 'AMC', side: 'BUY', status: 'WORKING', ...over }],
  });
  const pull = (env: unknown) =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([env]));

  it("adopts the broker's quantity when ours is stale", async () => {
    const id = placedIntentId(); // quantity 1
    pull(workingEnvelope({ total_quantity: '5' }));
    await reconcileIntent(id, 'ACC1');
    expect(getIntent(id)?.quantity).toBe(5);
    expect(getEvents(id).at(-1)?.detail).toMatch(/quantity corrected 1 → 5/);
  });

  it('ignores a missing or nonsensical quantity — absence is not evidence', async () => {
    for (const total of [undefined, '0', 'abc']) {
      db.exec('DELETE FROM order_events; DELETE FROM order_intents;');
      const id = placedIntentId();
      pull(workingEnvelope(total === undefined ? {} : { total_quantity: total }));
      await reconcileIntent(id, 'ACC1');
      expect(getIntent(id)?.quantity, `total_quantity=${total}`).toBe(1);
      vi.restoreAllMocks();
    }
  });

  it('never drops below what has already been booked', async () => {
    const id = placedIntentId();
    transitionIntent(id, 'partially_filled', { detail: 'partial' });
    advanceMaterialized(id, 1, 1.89); // a real share, already in the ledger
    pull(workingEnvelope({ total_quantity: '0.5', status: 'PARTIAL_FILLED' }));
    await reconcileIntent(id, 'ACC1');
    expect(getIntent(id)?.quantity).toBe(1);
  });

  it('leaves a COMBO alone — total_quantity is one leg, not the whole order', async () => {
    const rec = createIntent(intent({ bracket: { stopLossPrice: 1.5, takeProfitPrice: 2.5 } }), CID);
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'WB-B' });
    pull({
      client_order_id: CID,
      combo_order_id: 'WB-B',
      orders: [{ client_order_id: CID, combo_type: 'MASTER', status: 'WORKING', total_quantity: '99' }],
    });
    await reconcileIntent(rec.id, 'ACC1');
    expect(getIntent(rec.id)?.quantity).toBe(1);
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

  // An order whose placement outcome was UNKNOWN: left at 'submitted' with no
  // broker id, because we never got a response to read one from.
  const unknownOutcome = (cid: string): number => {
    const rec = createIntent(intent(), cid);
    transitionIntent(rec.id, 'validated');
    transitionIntent(rec.id, 'confirmed');
    transitionIntent(rec.id, 'submitted');
    return rec.id;
  };

  it('includes an unknown-outcome order despite it having no broker id', async () => {
    // The broker-id test alone excluded exactly the orders most in need of
    // resolving — possibly live, possibly filled, invisible until someone finds
    // out which.
    const id = unknownOutcome(CID);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp([]));
    const r = await reconcileAllWorking('ACC1');
    expect(r.results.map((x) => x.id)).toContain(id);
  });

  it('resolves an unknown-outcome order that had actually FILLED', async () => {
    // The likely case for a marketable limit: it fills inside the window before
    // the first reconcile, so the first status ever seen is FILLED. That is an
    // illegal jump from 'submitted', so it used to be skipped silently — the
    // order stuck at 'submitted' forever and the real position never booked.
    const id = unknownOutcome(CID);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filledEnvelope]));

    const r = await reconcileAllWorking('ACC1');

    expect(r.changed).toBe(1);
    expect(getIntent(id)?.state).toBe('filled');
    // The acknowledgement we never received is recorded before the fill, so the
    // audit trail reads the way it actually happened.
    const states = getEvents(id).map((e) => e.state);
    expect(states).toEqual(['draft', 'validated', 'confirmed', 'submitted', 'acknowledged', 'filled', 'filled']);
    expect(getEvents(id).find((e) => e.state === 'acknowledged')?.detail).toMatch(/outcome was unknown/i);
    // And the real shares reach the ledger.
    expect(listPositions({ status: 'open' })).toHaveLength(1);
  });

  it('leaves an unknown-outcome order alone while the broker has no record of it', async () => {
    const id = unknownOutcome(CID);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResp([]));
    await reconcileAllWorking('ACC1');
    // Not acknowledged on nothing, and not retired either — the human path has
    // no dedup slot to free, so it stays visible and resolvable.
    expect(getIntent(id)?.state).toBe('submitted');
  });

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

  it('skips an autotrade-owned intent mixed in with human ones — no broker call, no state change for it', async () => {
    const autotradeId = working('cid-auto');
    recordLiveOrder({
      intentId: autotradeId,
      symbol: 'AMC',
      stopPrice: 1.7,
      targetPrice: 2.2,
      riskAmount: 20,
      riskProfile: 'MODERATE',
    });
    const humanId = working(CID); // created second → higher id → reconciled first (newest-first)

    // Only ONE broker pull pair is mocked — if the autotrade-owned intent
    // wrongly reached the broker too, this would either throw (exhausted
    // mock) or the assertions below would catch the wrong state.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([filledEnvelope]));

    const r = await reconcileAllWorking('ACC1');
    expect(r.reconciled).toBe(2); // both still counted as "working"
    expect(r.results.find((x) => x.id === autotradeId)).toMatchObject({ changed: false });
    expect(r.results.find((x) => x.id === humanId)).toMatchObject({ changed: true });
    expect(getIntent(autotradeId)?.state).toBe('acknowledged'); // untouched
    expect(getIntent(humanId)?.state).toBe('filled');
    expect(listPositions()).toHaveLength(1); // only the human fill got recorded
    expect(listPositions()[0].sourceIntentId).toBe(humanId);
  });
});

// ---------------------------------------------------------------------------
// Partial-fill materialization. Booking a Position only at the terminal
// `filled` state meant a partial that was later CANCELLED — a legal terminal
// path — left real shares held with no position row at all: invisible to
// Positions, exposure, the open-risk caps, and every exit rule.
//
// The fix books the unbooked DELTA of the broker's running filled_quantity on
// every observation. That the field IS a running total is an unconfirmed
// assumption about the broker (see `npm run capture:broker`), so these tests
// pin both the happy path and every way the assumption could be wrong —
// each of which must fail toward UNDER-booking, never toward inventing shares.
// ---------------------------------------------------------------------------

/** A history envelope for a partly-filled order, in Webull's real shape. */
const partialEnvelope = (filled: number, price: number, total = 100, status = 'PARTIAL_FILLED') => ({
  client_order_id: CID,
  combo_type: 'NORMAL',
  combo_order_id: '8AIG1C8LCCE58QHNDSU5NHBP09',
  orders: [
    {
      symbol: 'AMC',
      side: 'BUY',
      status,
      client_order_id: CID,
      order_id: '8AIG1C8LCCE58QHNDSU5NHBP09',
      total_quantity: String(total),
      filled_quantity: String(filled),
      filled_price: String(price),
    },
  ],
});

/** A placed, broker-acknowledged order for `qty` shares. */
function placedFor(qty: number, over: Partial<OrderIntent> = {}): number {
  const rec = createIntent(intent({ quantity: qty, ...over }), CID);
  transitionIntent(rec.id, 'validated');
  transitionIntent(rec.id, 'confirmed');
  transitionIntent(rec.id, 'submitted');
  transitionIntent(rec.id, 'acknowledged', { brokerOrderId: '8AIG1C8LCCE58QHNDSU5NHBP09' });
  return rec.id;
}

/** Mock one reconcile's broker pull (open orders empty, then history). */
function mockPull(envelope: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(okResp([]))
    .mockResolvedValueOnce(okResp([envelope]));
}

describe('reconcileIntent — partial fills', () => {
  it('books a Position for a partial fill instead of waiting for terminal filled', async () => {
    const id = placedFor(100);
    mockPull(partialEnvelope(30, 5));

    const r = await reconcileIntent(id, 'ACC1');
    expect(r).toMatchObject({ ok: true, changed: true, materialized: 30 });
    expect(r.fillWarning).toBeUndefined();
    expect(getIntent(id)?.state).toBe('partially_filled');

    const pos = listPositions();
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ symbol: 'AMC', quantity: 30, entryPrice: 5, sourceIntentId: id });
    expect(getIntent(id)?.materializedQty).toBe(30);
  });

  it('books only the unbooked delta when the same fill is observed twice', async () => {
    // The real hazard: three independent callers (human Refresh, the Webull
    // scheduler, autotrade's loop) can each observe the same fill.
    const id = placedFor(100);
    mockPull(partialEnvelope(30, 5));
    await reconcileIntent(id, 'ACC1');
    vi.restoreAllMocks();

    mockPull(partialEnvelope(30, 5));
    const again = await reconcileIntent(id, 'ACC1');

    expect(again.materialized).toBe(0);
    expect(again.changed).toBe(false);
    expect(listPositions()).toHaveLength(1); // NOT double-booked
    expect(getIntent(id)?.materializedQty).toBe(30);
  });

  it('books the increment when a resting partial fills further', async () => {
    // 30/100 → 90/100 is NOT a state change (partially_filled either way), so
    // the old `target === intent.state` early return dropped the extra 60.
    const id = placedFor(100);
    mockPull(partialEnvelope(30, 5));
    await reconcileIntent(id, 'ACC1');
    vi.restoreAllMocks();

    // Running average across 90 shares: 30@5 then 60@6 → 5.6667.
    mockPull(partialEnvelope(90, (30 * 5 + 60 * 6) / 90));
    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBeCloseTo(60);
    expect(r.changed).toBe(true);
    const pos = listPositions().sort((a, b) => a.id - b.id);
    expect(pos).toHaveLength(2);
    // The second lot is priced at ITS OWN fill price, backed out of the running
    // average — not at the blended 5.667, which would misstate cost basis.
    expect(pos[1].quantity).toBeCloseTo(60);
    expect(pos[1].entryPrice).toBeCloseTo(6);
    expect(getIntent(id)?.materializedQty).toBeCloseTo(90);
  });

  it('keeps the shares booked when a partial is then CANCELLED — the silent-loss case', async () => {
    const id = placedFor(100);
    mockPull(partialEnvelope(30, 5));
    await reconcileIntent(id, 'ACC1');
    vi.restoreAllMocks();

    mockPull(partialEnvelope(30, 5, 100, 'CANCELLED'));
    await reconcileIntent(id, 'ACC1');

    expect(getIntent(id)?.state).toBe('cancelled');
    // Before the fix this was 0 positions — 30 real shares held, invisible.
    expect(listPositions()).toHaveLength(1);
    expect(listPositions()[0].quantity).toBe(30);
  });

  it('completes the book when a partial goes on to fill fully', async () => {
    const id = placedFor(100);
    mockPull(partialEnvelope(30, 5));
    await reconcileIntent(id, 'ACC1');
    vi.restoreAllMocks();

    mockPull(partialEnvelope(100, (30 * 5 + 70 * 7) / 100, 100, 'FILLED'));
    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBeCloseTo(70);
    expect(r.fillWarning).toBeUndefined(); // fully reconciled — no discrepancy
    expect(getIntent(id)?.state).toBe('filled');
    expect(getIntent(id)?.materializedQty).toBeCloseTo(100);
    const total = listPositions().reduce((s, p) => s + p.quantity, 0);
    expect(total).toBeCloseTo(100);
  });

  it('refuses to book when filled_quantity DECREASES — the assumption is violated', async () => {
    // A decrease means the broker reports each execution separately rather than
    // a running total, so differencing is invalid. Must refuse, not guess.
    const id = placedFor(100);
    mockPull(partialEnvelope(70, 5));
    await reconcileIntent(id, 'ACC1');
    vi.restoreAllMocks();

    mockPull(partialEnvelope(20, 5));
    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBe(0);
    expect(r.fillWarning).toMatch(/decreased/i);
    expect(listPositions()).toHaveLength(1); // still just the first 70
    expect(getIntent(id)?.materializedQty).toBe(70);
    // The refusal is in the audit trail, not swallowed.
    expect(getEvents(id).some((e) => e.detail?.includes('materialization:'))).toBe(true);
  });

  it('never books more than the order actually asked for', async () => {
    const id = placedFor(100);
    mockPull(partialEnvelope(140, 5, 100));
    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBe(100);
    expect(r.fillWarning).toMatch(/booking only/i);
    expect(listPositions()[0].quantity).toBe(100);
  });

  it('flags a filled order whose booked quantity falls short of what was ordered', async () => {
    const id = placedFor(100);
    // Broker jumps straight to FILLED but reports fewer shares than ordered.
    mockPull(partialEnvelope(60, 5, 100, 'FILLED'));
    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBe(60);
    expect(r.fillWarning).toMatch(/only 60 of 100/);
  });

  it('falls back to the average price when the implied incremental price is unusable', async () => {
    const id = placedFor(100);
    mockPull(partialEnvelope(30, 8));
    await reconcileIntent(id, 'ACC1');
    vi.restoreAllMocks();

    // A running average LOWER than the first lot's price implies a negative
    // incremental notional — inconsistent broker data, not a real free lot.
    mockPull(partialEnvelope(60, 2));
    const r = await reconcileIntent(id, 'ACC1');

    expect(r.materialized).toBeCloseTo(30);
    expect(r.fillWarning).toMatch(/falling back/i);
    const pos = listPositions().sort((a, b) => a.id - b.id);
    expect(pos[1].entryPrice).toBeCloseTo(2); // the reported average, not a negative
  });

  it('records a partial CLOSE as an exit against the open position', async () => {
    createPosition({
      assetType: 'stock',
      symbol: 'AMC',
      side: 'long',
      quantity: 100,
      entryPrice: 4,
      entryDate: '2026-07-01',
      tags: ['live'],
    });
    const id = placedFor(100, { side: 'sell', openClose: 'close' });
    mockPull(partialEnvelope(40, 6));

    const r = await reconcileIntent(id, 'ACC1');
    expect(r.materialized).toBe(40);

    const pos = listPositions({ status: 'open' })[0];
    expect(pos.remainingQuantity).toBe(60); // 40 of 100 closed
  });

  it('does not materialize a multi-leg combo, whose single-leg fields are null', async () => {
    const id = placedFor(2, { assetKind: 'option', optionStrategy: 'VERTICAL', optionType: undefined });
    mockPull(partialEnvelope(1, 1.2, 2));

    const r = await reconcileIntent(id, 'ACC1');
    expect(r.materialized).toBe(0);
    expect(listPositions()).toHaveLength(0);
  });
});
