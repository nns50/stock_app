import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, db } from '../src/db';
import { config } from '../src/config';
import { livePreview } from '../src/services/trading/livePreview';
import { setTradingConfig } from '../src/db/trading';
import type { OrderIntent } from '../src/services/trading/guardrails';

const orig = { ...config.webull };
beforeAll(() => initDb());
// BEFORE, not just after. setTradingConfig merges onto the existing row
// (`{...getTradingConfig(), ...patch}`), ten test files write trading_config,
// and they share one SQLite file with no guaranteed ordering between them. So
// cleaning up only in afterEach protects every OTHER file from this one while
// leaving this one at the mercy of whichever ran before it: `setTradingConfig({
// enabled: true })` would inherit a stale kill switch or a tight cap and every
// guardrail assertion here would fail.
//
// That is not theoretical — it turned CI red on 2026-09-05 while the same
// commit passed locally twice, purely because the file order differed. Every
// other file that touches this table already resets in beforeEach; this one was
// the outlier.
beforeEach(() => {
  db.exec('DELETE FROM trading_config');
});
afterEach(() => {
  Object.assign(config.webull, orig);
  db.exec('DELETE FROM trading_config');
  vi.restoreAllMocks();
});

const BALANCE = {
  total_market_value: '4.50',
  total_day_profit_loss: '0.00',
  total_net_liquidation_value: '15.31',
  account_currency_assets: [{ buying_power: '10.81', option_buying_power: '10.81' }],
};
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
const okResp = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as Response;

describe('live preview pipeline', () => {
  it('previews a single-leg option (account state → guardrails → broker estimate, OPTION body)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp({ estimated_cost: '10.00' }));

    const r = await livePreview(
      intent({
        symbol: 'NVDA',
        assetKind: 'option',
        optionType: 'call',
        strike: 200,
        expiration: '2026-12-19',
        quantity: 1,
        limitPrice: 0.1, // 1 × 100 × $0.10 = $10 ≤ $10.81 buying power
        referencePrice: 0.1,
      }),
      'ACC1',
    );
    expect(r.ok).toBe(true);
    expect(r.wouldSubmit).toBe(true);
    expect(r.preview?.ok).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
    expect(body.new_orders[0]).toMatchObject({ instrument_type: 'OPTION', option_strategy: 'SINGLE' });
  });

  it('previews a VERTICAL spread end-to-end (vertical-mode guardrails + VERTICAL body)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([{ account_id: 'ACC1', account_type: 'INDIVIDUAL_MARGIN' }])) // account-list
      .mockResolvedValueOnce(okResp({ estimated_cost: '1.00' }));

    const r = await livePreview(
      intent({
        symbol: 'AMC',
        assetKind: 'option',
        quantity: 1,
        limitPrice: 0.01, // net
        referencePrice: undefined,
        optionStrategy: 'VERTICAL',
        optionLegs: [
          { side: 'buy', optionType: 'call', strike: 6, expiration: '2026-07-17' },
          { side: 'sell', optionType: 'call', strike: 7, expiration: '2026-07-17' },
        ],
      }),
      'ACC1',
    );
    const rules = (r.guardrails?.checks ?? []).map((c) => c.rule);
    // Vertical mode: spread_legs runs; the single-leg position/short rules are skipped.
    expect(rules).toContain('spread_legs');
    expect(rules).not.toContain('position_size');
    expect(rules).not.toContain('naked_short');
    // And the broker body is a VERTICAL with 2 legs (calls[2] is now account-list).
    const body = JSON.parse((fetchSpy.mock.calls[3][1] as RequestInit).body as string);
    expect(body.new_orders[0]).toMatchObject({ option_strategy: 'VERTICAL' });
    expect(body.new_orders[0].legs).toHaveLength(2);
  });

  it('errors when account state cannot load (not configured)', async () => {
    Object.assign(config.webull, { appKey: '', appSecret: '' });
    const r = await livePreview(intent(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('pulls account state, passes guardrails, then previews (no place)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // account-state: balance
      .mockResolvedValueOnce(okResp([])) // account-state: positions (none)
      .mockResolvedValueOnce(okResp({ estimated_cost: '5.00' })); // preview

    const r = await livePreview(intent(), 'ACC1');
    expect(r.ok).toBe(true);
    expect(r.wouldSubmit).toBe(true);
    expect(r.accountState?.buyingPowerUsd).toBe(10.81);
    expect(r.preview?.ok).toBe(true);
    expect(r.preview?.estimate?.costUsd).toBe(5);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/openapi/trade/order/preview');
  });

  it('surfaces the settled_cash warning end-to-end when a buy exceeds settled cash', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const balanceWithThinSettledCash = {
      ...BALANCE,
      account_currency_assets: [{ ...BALANCE.account_currency_assets[0], settled_cash: '1.00' }],
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(balanceWithThinSettledCash))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp({ estimated_cost: '5.00' }));

    // intent()'s default: 1 share x $5 limit = $5 notional, exceeding the $1 settled cash above.
    const r = await livePreview(intent(), 'ACC1');
    expect(r.ok).toBe(true); // a warning never blocks
    const settledCashCheck = r.guardrails?.checks.find((c) => c.rule === 'settled_cash');
    expect(settledCashCheck).toMatchObject({ severity: 'warn', passed: false });
  });

  it('still fetches the broker estimate for a guardrail-blocked (but valid) order', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE)) // balance: BP 10.81
      .mockResolvedValueOnce(okResp([])) // positions
      .mockResolvedValueOnce(okResp({ estimated_cost: '100.00' })); // preview (informational)

    // 20 × $5 = $100 notional > $10.81 buying power ⇒ buying_power blocks, but
    // the order is structurally valid so the broker estimate is still fetched.
    const r = await livePreview(intent({ quantity: 20 }), 'ACC1');
    expect(r.wouldSubmit).toBe(false);
    expect(r.guardrails?.checks.find((c) => c.rule === 'buying_power')?.passed).toBe(false);
    expect(r.preview?.ok).toBe(true); // estimate fetched despite the block
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('skips the broker when the kill switch is engaged', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true, killSwitch: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]));

    const r = await livePreview(intent(), 'ACC1');
    expect(r.wouldSubmit).toBe(false);
    expect(r.preview).toBeUndefined(); // halted — no broker call
    expect(fetchSpy).toHaveBeenCalledTimes(2); // balance + positions only
  });

  it('skips the broker for a malformed order (no limit price)', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce(okResp([]));

    const r = await livePreview(intent({ orderType: 'limit', limitPrice: undefined }), 'ACC1');
    expect(r.preview).toBeUndefined(); // malformed — no broker call
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('parity with the place step (2026-07-28)', () => {
  it('counts the ORDER INSTRUMENT, not the per-underlying aggregate — long stock must not cover a short option', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true, allowNakedShort: false });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      // Broker holds 500 shares of NVDA STOCK — and no option contracts.
      .mockResolvedValueOnce(okResp([{ symbol: 'NVDA', instrument_type: 'EQUITY', quantity: '500', cost_price: '1' }]));

    const r = await livePreview(
      intent({
        symbol: 'NVDA',
        assetKind: 'option',
        side: 'sell',
        optionType: 'call',
        strike: 200,
        expiration: '2026-12-19',
        quantity: 1,
        limitPrice: 0.1,
        referencePrice: 0.1,
      }),
      'ACC1',
    );

    expect(r.ok).toBe(true);
    // The unscoped lookup summed the stock into currentPositionQty (+500), so
    // selling one call read as reducing a long — "would submit" for an order
    // the instrument-scoped place step then blocked as a naked short.
    expect(r.accountState?.currentPositionQty).toBe(0);
    expect(r.wouldSubmit).toBe(false);
    expect(r.guardrails?.checks.find((c) => c.rule === 'naked_short')?.passed).toBe(false);
  });

  it('fails closed when broker positions cannot be read, exactly like placeOrder', async () => {
    Object.assign(config.webull, { appKey: 'k', appSecret: 's', region: 'us' });
    setTradingConfig({ enabled: true });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResp(BALANCE))
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => JSON.stringify({ msg: 'down' }) } as Response);

    const r = await livePreview(intent(), 'ACC1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not verify current positions/i);
  });
});
