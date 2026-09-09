import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The two guards that need a BROKER answer to exercise. routes.integration
// covers the pure-validation refusals and the fail-closed 502 against the real
// unconfigured provider; this file mocks the account read so the held-quantity
// arithmetic — the one thing standing between this route and a naked short —
// is actually driven.
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/positions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/webull/positions')>()),
  previewWebullPositions: vi.fn(),
}));
vi.mock('../src/providers/webull/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/webull/orders')>()),
  webullPlaceStandaloneBracket: vi.fn(),
  listWebullOpenOrders: vi.fn(),
  webullCancelOrder: vi.fn(),
}));

import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { initDb } from '../src/db';
import { config } from '../src/config';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { webullAccountState } from '../src/providers/webull/accountState';
import { listWebullOpenOrders, webullCancelOrder, webullPlaceStandaloneBracket } from '../src/providers/webull/orders';
import { previewWebullPositions } from '../src/providers/webull/positions';

const mockAccount = vi.mocked(webullAccountState);
const mockPlace = vi.mocked(webullPlaceStandaloneBracket);
const mockOpen = vi.mocked(listWebullOpenOrders);
const mockCancel = vi.mocked(webullCancelOrder);
const mockHoldings = vi.mocked(previewWebullPositions);

let base = '';
beforeAll(async () => {
  initDb();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const held = (currentPositionQty: number) =>
  ({
    ok: true,
    accountId: 'ACC1',
    netLiquidationUsd: 5192,
    state: { buyingPowerUsd: 8000, exposureUsd: 0, realizedPnlTodayUsd: 0, ordersToday: 0, currentPositionQty },
  }) as Awaited<ReturnType<typeof webullAccountState>>;

const post = (body: unknown) =>
  fetch(`${base}/api/autotrade/live/standalone-bracket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const ok = { symbol: 'SMCI', quantity: 1, stopLossPrice: 30, takeProfitPrice: 60, confirmation: 'SMCI' };

beforeEach(() => {
  vi.clearAllMocks();
  setAutotradeConfig({ liveAccountId: 'ACC1' });
  config.trading.placeEnabled = true;
  mockAccount.mockResolvedValue(held(52));
  mockPlace.mockResolvedValue({ ok: true, clientComboOrderId: 'COMBO-TEST' } as Awaited<
    ReturnType<typeof webullPlaceStandaloneBracket>
  >);
  mockCancel.mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof webullCancelOrder>>);
  mockOpen.mockResolvedValue({
    ok: true,
    orders: [
      { clientOrderId: 'a', comboOrderId: 'GRP-1', symbol: 'FCX', side: 'sell', status: 'OPEN' },
      { clientOrderId: 'b', comboOrderId: 'GRP-1', symbol: 'FCX', side: 'sell', status: 'OPEN' },
      { clientOrderId: 'c', comboOrderId: 'GRP-2', symbol: 'FCX', side: 'sell', status: 'OPEN' },
    ],
  } as Awaited<ReturnType<typeof listWebullOpenOrders>>);
});

describe('POST /api/autotrade/live/standalone-bracket', () => {
  it('refuses a quantity larger than the shares the BROKER says are held', async () => {
    const r = await post({ ...ok, quantity: 53 }); // 52 held
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/is a short, not protection/);
    // and nothing reached the broker
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('refuses when the account holds none of the symbol', async () => {
    mockAccount.mockResolvedValue(held(0));
    const r = await post(ok);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/holds no SMCI/);
    expect(mockPlace).not.toHaveBeenCalled();
  });

  it('allows exactly the held quantity — the boundary is <=, not <', async () => {
    const r = await post({ ...ok, quantity: 52 });
    expect(r.status).toBe(200);
    expect(mockPlace).toHaveBeenCalledTimes(1);
  });

  // The guard the FIRST real call to this route walked straight into. It
  // shipped checking `quantity > held` and nothing else; the broker refused a
  // 1-share bracket on FCX against 38 held, because a full-size bracket was
  // already resting and it counts held MINUS committed.
  describe('the resting book, not just the holding', () => {
    it('refuses when resting exits already spoken for the whole holding', async () => {
      mockOpen.mockResolvedValue({
        ok: true,
        orders: [
          { clientOrderId: 'x', comboOrderId: 'G1', symbol: 'SMCI', side: 'sell', status: 'SUBMITTED', quantity: 52 },
          { clientOrderId: 'y', comboOrderId: 'G1', symbol: 'SMCI', side: 'sell', status: 'SUBMITTED', quantity: 52 },
        ],
      } as Awaited<ReturnType<typeof listWebullOpenOrders>>);
      const r = await post(ok); // 1 share, 52 held
      expect(r.status).toBe(400);
      const { error } = (await r.json()) as { error: string };
      // The OCO pair counts ONCE. If this said 104 the arithmetic would be wrong
      // in the direction that reports the account as already short.
      expect(error).toMatch(/52 held, 52 already committed/);
      expect(error).toMatch(/so 0 can be protected/);
      expect(mockPlace).not.toHaveBeenCalled();
    });

    it('allows exactly the UNCOMMITTED remainder, and refuses one more', async () => {
      mockOpen.mockResolvedValue({
        ok: true,
        orders: [
          { clientOrderId: 'x', comboOrderId: 'G1', symbol: 'SMCI', side: 'sell', status: 'SUBMITTED', quantity: 20 },
          { clientOrderId: 'y', comboOrderId: 'G1', symbol: 'SMCI', side: 'sell', status: 'SUBMITTED', quantity: 20 },
        ],
      } as Awaited<ReturnType<typeof listWebullOpenOrders>>);
      expect((await post({ ...ok, quantity: 32 })).status).toBe(200); // 52 - 20
      expect((await post({ ...ok, quantity: 33 })).status).toBe(400);
      expect(mockPlace).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the resting book cannot be read at all', async () => {
      mockOpen.mockResolvedValue({ ok: false, orders: [], error: 'boom' } as Awaited<
        ReturnType<typeof listWebullOpenOrders>
      >);
      expect((await post(ok)).status).toBe(502);
      expect(mockPlace).not.toHaveBeenCalled();
    });

    it('fails closed when a resting leg carries no quantity', async () => {
      mockOpen.mockResolvedValue({
        ok: true,
        orders: [{ clientOrderId: 'x', comboOrderId: 'G1', symbol: 'SMCI', side: 'sell', status: 'SUBMITTED' }],
      } as Awaited<ReturnType<typeof listWebullOpenOrders>>);
      const r = await post(ok);
      expect(r.status).toBe(502);
      expect(((await r.json()) as { error: string }).error).toMatch(/cannot be computed/);
      expect(mockPlace).not.toHaveBeenCalled();
    });
  });

  it('places a no-MASTER bracket on the CLOSING side and returns the raw payload', async () => {
    const r = await post(ok);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; heldAtBroker: number; clientComboOrderId?: string };
    expect(body).toMatchObject({ ok: true, heldAtBroker: 52, clientComboOrderId: 'COMBO-TEST' });
    const [accountId, intent, tp, sl] = mockPlace.mock.calls[0];
    expect(accountId).toBe('ACC1');
    // The ENTRY side is passed; bracketExit emits the legs on the closing side,
    // exactly as the entry bracket does. openClose 'close' is what makes it a
    // protective bracket over shares held rather than a new position.
    expect(intent).toMatchObject({ symbol: 'SMCI', assetKind: 'stock', side: 'buy', openClose: 'close', quantity: 1 });
    expect(tp).toBe(60);
    expect(sl).toBe(30);
  });

  it('journals the outcome either way, with the held quantity it judged against', async () => {
    await post(ok);
    const armed = listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearmed'], limit: 20 })[0];
    expect(JSON.parse(armed?.detail ?? '{}')).toMatchObject({ quantity: 1, heldAtBroker: 52 });

    mockPlace.mockResolvedValue({ ok: false, error: 'rejected by broker' } as Awaited<
      ReturnType<typeof webullPlaceStandaloneBracket>
    >);
    const r = await post(ok);
    expect(r.status).toBe(200); // a refused PLACEMENT is a reported result, not an HTTP error
    expect(((await r.json()) as { ok: boolean }).ok).toBe(false);
    const failed = listAutotradeEvents({ stage: 'execution', actions: ['live_bracket_rearm_failed'], limit: 20 })[0];
    expect(JSON.parse(failed?.detail ?? '{}')).toMatchObject({ error: 'rejected by broker' });
  });
});

describe('GET /api/autotrade/live/open-orders', () => {
  it('counts DISTINCT combo groups — the question the endpoint exists for', async () => {
    const r = await fetch(`${base}/api/autotrade/live/open-orders`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { count: number; comboGroups: { comboOrderId: string; legs: number }[] };
    expect(b.count).toBe(3);
    expect(b.comboGroups).toEqual([
      { comboOrderId: 'GRP-1', legs: 2 },
      { comboOrderId: 'GRP-2', legs: 1 },
    ]);
  });

  it('fails closed when the broker cannot be read', async () => {
    mockOpen.mockResolvedValue({ ok: false, orders: [], error: 'boom' } as Awaited<
      ReturnType<typeof listWebullOpenOrders>
    >);
    const r = await fetch(`${base}/api/autotrade/live/open-orders`);
    expect(r.status).toBe(502);
  });
});

describe('POST /api/autotrade/live/cancel-order', () => {
  const post = (body: unknown) =>
    fetch(`${base}/api/autotrade/live/cancel-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('requires the confirmation to repeat the client order id exactly', async () => {
    // A symbol-shaped confirmation would let a slip cancel the wrong leg of the
    // right stock, which is how a stop gets pulled by accident.
    const r = await post({ clientOrderId: 'LEG-1', confirmation: 'FCX' });
    expect(r.status).toBe(400);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('cancels and journals, naming the naked-position risk', async () => {
    const r = await post({ clientOrderId: 'LEG-1', confirmation: 'LEG-1' });
    expect(r.status).toBe(200);
    expect(mockCancel).toHaveBeenCalledWith('ACC1', 'LEG-1');
    const ev = listAutotradeEvents({ stage: 'execution', actions: ['live_order_cancelled_by_hand'], limit: 10 })[0];
    expect(JSON.parse(ev?.detail ?? '{}')).toMatchObject({ clientOrderId: 'LEG-1' });
    expect(String(ev?.detail)).toMatch(/now unprotected/);
  });

  it('works even when placement is disabled — cancelling is the safe direction', async () => {
    config.trading.placeEnabled = false;
    const r = await post({ clientOrderId: 'LEG-1', confirmation: 'LEG-1' });
    expect(r.status).toBe(200);
    expect(mockCancel).toHaveBeenCalled();
  });

  it('reports a refused cancel rather than throwing', async () => {
    mockCancel.mockResolvedValue({ ok: false, error: 'already filled' } as Awaited<
      ReturnType<typeof webullCancelOrder>
    >);
    const r = await post({ clientOrderId: 'LEG-1', confirmation: 'LEG-1' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(false);
    expect(
      listAutotradeEvents({ stage: 'execution', actions: ['live_order_cancel_by_hand_failed'], limit: 10 }),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /live/holdings — the read that did not exist.
//
// Three times in one session the question "does the broker still hold this?"
// had to be inferred from a side effect, once by sending a deliberately
// oversized protective order purely so its own guard would refuse it and name
// the held quantity. A read dressed as a write.
// ---------------------------------------------------------------------------
describe('GET /api/autotrade/live/holdings', () => {
  const preview = (over: Partial<Awaited<ReturnType<typeof previewWebullPositions>>> = {}) =>
    ({
      ok: true,
      accountId: 'ACC1',
      positions: [],
      unmapped: 0,
      unmappedOptions: 0,
      unmappedSample: [],
      unmappedSymbols: [],
      ...over,
    }) as Awaited<ReturnType<typeof previewWebullPositions>>;
  const stock = (symbol: string, quantity: number, side: 'long' | 'short' = 'long') =>
    ({ assetType: 'stock', symbol, side, quantity, entryPrice: 1, entryDate: null }) as never;

  it('rolls equity rows up per symbol', async () => {
    mockHoldings.mockResolvedValue(
      preview({ positions: [stock('NOK', 80), stock('SMCI', 47), stock('NOK', 20)] as never[] }),
    );
    const r = await fetch(`${base}/api/autotrade/live/holdings`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { holdings: { symbol: string; quantity: number }[] };
    expect(b.holdings).toEqual([
      { symbol: 'NOK', quantity: 100 },
      { symbol: 'SMCI', quantity: 47 },
    ]);
  });

  it('answers a single symbol, which is the question it exists for', async () => {
    mockHoldings.mockResolvedValue(preview({ positions: [stock('SMCI', 47)] as never[] }));
    const r = await fetch(`${base}/api/autotrade/live/holdings?symbol=nok`);
    const b = (await r.json()) as { symbol: string; quantity: number; known: boolean };
    // Flat, positively — which is what the NOK incident needed and could not get.
    expect(b).toMatchObject({ symbol: 'NOK', quantity: 0, known: true });
  });

  it('signs a SHORT negative rather than reporting it as held long', async () => {
    mockHoldings.mockResolvedValue(preview({ positions: [stock('NOK', 50, 'short')] as never[] }));
    const b = (await (await fetch(`${base}/api/autotrade/live/holdings?symbol=NOK`)).json()) as { quantity: number };
    expect(b.quantity).toBe(-50);
  });

  it('marks an UNMAPPABLE symbol as known:false — held, quantity unknown, NOT zero', async () => {
    // The false negative this endpoint must never produce. A row the mapper
    // cannot parse still proves the broker holds something in that symbol; the
    // close-detector already freezes on exactly this signal.
    mockHoldings.mockResolvedValue(preview({ positions: [], unmapped: 1, unmappedSymbols: ['NOK'] }));
    const b = (await (await fetch(`${base}/api/autotrade/live/holdings?symbol=NOK`)).json()) as {
      quantity: number;
      known: boolean;
    };
    expect(b.known).toBe(false);
    expect(b.quantity).toBe(0); // present, but the caller must not trust it
  });

  it('lists unknown symbols separately in the full read', async () => {
    mockHoldings.mockResolvedValue(preview({ positions: [stock('SMCI', 47)] as never[], unmappedSymbols: ['nok'] }));
    const b = (await (await fetch(`${base}/api/autotrade/live/holdings`)).json()) as { unknownSymbols: string[] };
    expect(b.unknownSymbols).toEqual(['NOK']);
  });

  it('excludes OPTION rows from the share roll-up', async () => {
    // An option row's quantity is contracts on one contract. Summing it beside
    // share counts produces a number that means nothing.
    mockHoldings.mockResolvedValue(
      preview({
        positions: [stock('SMCI', 47), { assetType: 'option', symbol: 'SMCI', side: 'long', quantity: 3 } as never],
      }),
    );
    const b = (await (await fetch(`${base}/api/autotrade/live/holdings?symbol=SMCI`)).json()) as { quantity: number };
    expect(b.quantity).toBe(47);
  });

  it('fails closed when the broker cannot be read', async () => {
    mockHoldings.mockResolvedValue(preview({ ok: false, error: 'boom' }));
    expect((await fetch(`${base}/api/autotrade/live/holdings`)).status).toBe(502);
  });
});
