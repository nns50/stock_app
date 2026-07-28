import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { createIntent, getIntent, transitionIntent } from '../src/db/orders';
import { setTradingConfig } from '../src/db/trading';
import { replaceIntent } from '../src/services/trading/replaceOrder';
import type { OrderIntent } from '../src/services/trading/guardrails';

// Pin the own-book side of the daily-loss halt flat: these tests share one
// SQLite file with every other suite, and exits other files date today would
// otherwise leak into webullAccountState's realized-today derivation here.
// The derivation itself is covered in webullAccountState.test.ts.
vi.mock('../src/services/trading/realizedToday', () => ({
  realizedTodayFromBook: vi.fn(() => ({
    totalUsd: 0,
    journalUsd: 0,
    liveOptionsUsd: 0,
    journalExitCount: 0,
    liveOptionsCloseCount: 0,
  })),
}));

const origWebull = { ...config.webull };
const origPlace = config.trading.placeEnabled;
const CID = 'replace-cid-1';

beforeAll(() => initDb());
beforeEach(() => {
  db.exec(
    'DELETE FROM autotrade_live_orders; DELETE FROM autotrade_live_options_orders; ' +
      'DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM trading_config;',
  );
  config.trading.placeEnabled = true;
  Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
  setTradingConfig({ enabled: true });
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

function workingIntentId(over: Partial<OrderIntent> = {}, key = CID): number {
  const rec = createIntent(intent(over), key);
  transitionIntent(rec.id, 'validated');
  transitionIntent(rec.id, 'confirmed');
  transitionIntent(rec.id, 'submitted');
  transitionIntent(rec.id, 'acknowledged', { brokerOrderId: 'WB-REP-1' });
  return rec.id;
}

describe('replaceIntent', () => {
  it('refuses when TRADING_ENABLED is off', async () => {
    config.trading.placeEnabled = false;
    const r = await replaceIntent(workingIntentId(), 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'trading_disabled' });
  });

  it('refuses a terminal order', async () => {
    const id = workingIntentId();
    transitionIntent(id, 'filled', { detail: 'filled' });
    const r = await replaceIntent(id, 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'not_open' });
  });

  it('refuses to modify a multi-leg spread in place (no account or broker call)', async () => {
    const id = workingIntentId({ assetKind: 'option', optionStrategy: 'VERTICAL' }, 'vert-cid');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await replaceIntent(id, 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'not_modifiable' });
    expect(r.error).toMatch(/spread/i);
    expect(fetchSpy).not.toHaveBeenCalled(); // gated before account state / broker
  });

  it('refuses to modify a bracketed order in place (cancel & re-place instead)', async () => {
    const id = workingIntentId({ bracket: { takeProfitPrice: 2.0, stopLossPrice: 1.0 } }, 'brk-cid');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await replaceIntent(id, 'ACC1', { quantity: 3 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'not_modifiable' });
    expect(r.error).toMatch(/bracket/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still modifies a single-leg option in place (SINGLE is not a combo)', async () => {
    const id = workingIntentId(
      { assetKind: 'option', optionType: 'call', strike: 2, expiration: '2030-01-18', optionStrategy: 'SINGLE' },
      'single-opt-cid',
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // account state: balance
      .mockResolvedValueOnce(okResp([])) // account state: positions
      .mockResolvedValueOnce(okResp({ ok: true })) // /replace
      .mockResolvedValueOnce(okResp([])) // reconcile: open
      .mockResolvedValueOnce(okResp([])); // reconcile: history
    // 1 contract × $0.05 × 100 = $5, within the mocked option buying power ($10.81).
    const r = await replaceIntent(id, 'ACC1', { limitPrice: 0.05 });
    expect(r).toMatchObject({ ok: true, replaced: true, reason: 'replaced' });
  });

  it('blocks when the modified order fails a guardrail (no broker call)', async () => {
    const id = workingIntentId();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([])); // account state only
    // 1000 × $1.50 = $1,500 > $500 cap
    const r = await replaceIntent(id, 'ACC1', { quantity: 1000 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'blocked' });
    expect(r.guardrails?.checks.find((c) => c.rule === 'order_notional')?.passed).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no /replace
  });

  it('replaces, persists the new values, and reconciles', async () => {
    const id = workingIntentId();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // account state: balance
      .mockResolvedValueOnce(okResp([])) // account state: positions
      .mockResolvedValueOnce(okResp({ ok: true })) // /replace
      .mockResolvedValueOnce(okResp([])) // reconcile: open
      .mockResolvedValueOnce(okResp([])); // reconcile: history

    const r = await replaceIntent(id, 'ACC1', { quantity: 2, limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: true, reason: 'replaced' });
    expect(getIntent(id)).toMatchObject({ quantity: 2, limitPrice: 1.6 });
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/openapi/trade/order/replace');
  });

  it('reports a broker rejection without persisting the change', async () => {
    const id = workingIntentId();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ msg: 'too late' }),
      } as Response);

    const r = await replaceIntent(id, 'ACC1', { limitPrice: 1.6 });
    expect(r).toMatchObject({ ok: true, replaced: false, reason: 'broker_rejected' });
    expect(getIntent(id)?.limitPrice).toBe(1.5); // unchanged
  });

  // A modify is nonIdempotent, so a lost response is never retried — and it was
  // reported as a rejection, which is a claim we can't make. If the modify DID
  // apply, our stored quantity is short of the order's, and computeFillDelta
  // clamps every future booking to that stale ceiling: real shares that no
  // ledger can ever see.
  describe('unknown modify outcome', () => {
    const lostReplace = (status: number) =>
      vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(okResp(BALANCE)) // account balance
        .mockResolvedValueOnce(okResp([])) // account positions
        .mockResolvedValueOnce({ ok: false, status, text: async () => JSON.stringify({ msg: 'gateway' }) } as Response)
        .mockResolvedValueOnce(okResp([])) // reconcile: open
        .mockResolvedValueOnce(okResp([])); // reconcile: history

    it('reports it as unknown, not rejected, and persists nothing', async () => {
      const id = workingIntentId();
      lostReplace(504);
      const r = await replaceIntent(id, 'ACC1', { quantity: 5, limitPrice: 1.6 });

      expect(r).toMatchObject({ ok: true, replaced: false, reason: 'outcome_unknown' });
      expect(r.error).toMatch(/did not respond/i);
      // Neither guess is made: the record is untouched, and it was re-checked.
      expect(getIntent(id)).toMatchObject({ quantity: 1, limitPrice: 1.5 });
      expect(r.reconciled).toBeDefined();
    });

    it.each([
      ['a network error / client timeout', 0],
      ['a rate limit', 429],
      ['a server error', 500],
    ])('treats %s as unknown', async (_label, status) => {
      const id = workingIntentId();
      if (status === 0) {
        vi.spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(okResp(BALANCE))
          .mockResolvedValueOnce(okResp([]))
          .mockRejectedValueOnce(new Error('socket hang up'))
          .mockResolvedValueOnce(okResp([]))
          .mockResolvedValueOnce(okResp([]));
      } else {
        lostReplace(status);
      }
      const r = await replaceIntent(id, 'ACC1', { quantity: 5 });
      expect(r.reason).toBe('outcome_unknown');
    });

    it("adopts the broker's own quantity when the lost modify had actually applied", async () => {
      // The whole point: the broker settles it authoritatively, so the stale
      // ceiling that made the extra shares unbookable is corrected.
      const id = workingIntentId();
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(okResp(BALANCE))
        .mockResolvedValueOnce(okResp([]))
        .mockResolvedValueOnce({ ok: false, status: 0, text: async () => '' } as Response)
        .mockResolvedValueOnce(okResp([])) // reconcile: open
        .mockResolvedValueOnce(
          okResp([
            {
              client_order_id: CID,
              combo_order_id: 'WB-REP-1',
              orders: [{ client_order_id: CID, status: 'WORKING', total_quantity: '5', symbol: 'AMC', side: 'BUY' }],
            },
          ]),
        );

      const r = await replaceIntent(id, 'ACC1', { quantity: 5 });

      expect(r.reason).toBe('outcome_unknown');
      expect(getIntent(id)?.quantity).toBe(5); // corrected from the broker, not guessed
    });
  });
});
