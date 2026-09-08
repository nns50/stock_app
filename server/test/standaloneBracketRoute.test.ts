import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The two guards that need a BROKER answer to exercise. routes.integration
// covers the pure-validation refusals and the fail-closed 502 against the real
// unconfigured provider; this file mocks the account read so the held-quantity
// arithmetic — the one thing standing between this route and a naked short —
// is actually driven.
vi.mock('../src/providers/webull/accountState', () => ({ webullAccountState: vi.fn() }));
vi.mock('../src/providers/webull/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/webull/orders')>()),
  webullPlaceStandaloneBracket: vi.fn(),
}));

import type { AddressInfo } from 'node:net';
import { app } from '../src/index';
import { initDb } from '../src/db';
import { config } from '../src/config';
import { setAutotradeConfig } from '../src/db/autotradeConfig';
import { listAutotradeEvents } from '../src/db/autotradeEvents';
import { webullAccountState } from '../src/providers/webull/accountState';
import { webullPlaceStandaloneBracket } from '../src/providers/webull/orders';

const mockAccount = vi.mocked(webullAccountState);
const mockPlace = vi.mocked(webullPlaceStandaloneBracket);

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
