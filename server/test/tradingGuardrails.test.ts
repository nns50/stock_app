import { describe, it, expect } from 'vitest';
import {
  evaluateGuardrails,
  defaultTradingConfig,
  blockingFailures,
  type OrderIntent,
  type AccountState,
  type TradingConfig,
  type GuardrailReport,
} from '../src/services/trading/guardrails';

// Baselines that pass every rule; each test overrides just what it exercises.
const cfg = (over: Partial<TradingConfig> = {}): TradingConfig => ({
  ...defaultTradingConfig(),
  enabled: true, // armed, so we can exercise the risk rules
  ...over,
});
const acct = (over: Partial<AccountState> = {}): AccountState => ({
  buyingPowerUsd: 100_000,
  exposureUsd: 0,
  realizedPnlTodayUsd: 0,
  ordersToday: 0,
  currentPositionQty: 0,
  ...over,
});
const order = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: 'AAPL',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 10,
  orderType: 'limit',
  limitPrice: 10,
  referencePrice: 10,
  ...over,
});

const check = (r: GuardrailReport, rule: string) => r.checks.find((c) => c.rule === rule)!;
const failed = (r: GuardrailReport) => blockingFailures(r).map((c) => c.rule);

describe('trading guardrails', () => {
  it('passes a clean, small, armed order', () => {
    const r = evaluateGuardrails(order(), acct(), cfg());
    expect(r.ok).toBe(true);
    expect(blockingFailures(r)).toHaveLength(0);
  });

  it('lists every rule in the breakdown (passed or not)', () => {
    const r = evaluateGuardrails(order(), acct(), cfg());
    for (const rule of [
      'quantity',
      'limit_price',
      'trading_enabled',
      'kill_switch',
      'order_notional',
      'buying_power',
      'account_exposure',
      'position_size',
      'daily_loss_halt',
      'max_orders_per_day',
      'fat_finger',
      'naked_short',
    ]) {
      expect(check(r, rule)).toBeDefined();
    }
  });

  it('blocks when trading is disabled', () => {
    const r = evaluateGuardrails(order(), acct(), cfg({ enabled: false }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('trading_enabled');
  });

  it('blocks when the kill switch is engaged', () => {
    const r = evaluateGuardrails(order(), acct(), cfg({ killSwitch: true }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('kill_switch');
  });

  it('blocks a market order in an overnight/extended session (limit-only outside RTH)', () => {
    const r = evaluateGuardrails(
      order({ session: 'overnight', orderType: 'market', limitPrice: undefined }),
      acct(),
      cfg(),
    );
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('session_order_type');
  });

  it('allows a limit order in an overnight session, and omits the rule for regular hours', () => {
    const overnight = evaluateGuardrails(order({ session: 'overnight' }), acct(), cfg());
    expect(overnight.ok).toBe(true);
    expect(check(overnight, 'session_order_type').passed).toBe(true);
    // The rule only appears outside regular hours.
    const regular = evaluateGuardrails(order(), acct(), cfg());
    expect(regular.checks.find((c) => c.rule === 'session_order_type')).toBeUndefined();
  });

  it('blocks a market option (no market options) but allows limit/stop types; omits the rule for stocks', () => {
    const market = evaluateGuardrails(
      order({ assetKind: 'option', orderType: 'market', limitPrice: undefined, multiplier: 100 }),
      acct(),
      cfg(),
    );
    expect(market.ok).toBe(false);
    expect(failed(market)).toContain('option_order_type');

    // A small limit option passes the rule; a stop option does too; stocks never see it.
    const limitOpt = evaluateGuardrails(
      order({ assetKind: 'option', quantity: 1, limitPrice: 1, referencePrice: 1, multiplier: 100 }),
      acct(),
      cfg(),
    );
    expect(check(limitOpt, 'option_order_type').passed).toBe(true);
    const stopOpt = evaluateGuardrails(
      order({
        assetKind: 'option',
        quantity: 1,
        orderType: 'stop_loss',
        stopPrice: 1,
        referencePrice: 1,
        multiplier: 100,
      }),
      acct(),
      cfg(),
    );
    expect(check(stopOpt, 'option_order_type').passed).toBe(true);
    expect(
      evaluateGuardrails(order(), acct(), cfg()).checks.find((c) => c.rule === 'option_order_type'),
    ).toBeUndefined();
  });

  it('requires a stop price for stop orders, and a limit price for stop-limit', () => {
    const noStop = evaluateGuardrails(order({ orderType: 'stop_loss', stopPrice: undefined }), acct(), cfg());
    expect(failed(noStop)).toContain('stop_price');

    const stop = evaluateGuardrails(order({ orderType: 'stop_loss', stopPrice: 9 }), acct(), cfg());
    expect(check(stop, 'stop_price').passed).toBe(true);
    expect(stop.checks.find((c) => c.rule === 'limit_price')?.passed).toBe(true); // stop_loss needs no limit

    const stopLimNoLimit = evaluateGuardrails(
      order({ orderType: 'stop_loss_limit', stopPrice: 9, limitPrice: undefined }),
      acct(),
      cfg(),
    );
    expect(failed(stopLimNoLimit)).toContain('limit_price');

    const stopLim = evaluateGuardrails(
      order({ orderType: 'stop_loss_limit', stopPrice: 9, limitPrice: 9 }),
      acct(),
      cfg(),
    );
    expect(check(stopLim, 'stop_price').passed).toBe(true);
    expect(check(stopLim, 'limit_price').passed).toBe(true);
  });

  it('blocks an order over the notional cap', () => {
    // 10 × $100 = $1,000 > $500 cap
    const r = evaluateGuardrails(order({ limitPrice: 100, referencePrice: 100 }), acct(), cfg());
    expect(failed(r)).toContain('order_notional');
  });

  it('values an option notional with the contract multiplier', () => {
    // 2 contracts × 100 × $3 = $600 > $500 cap
    const r = evaluateGuardrails(
      order({
        assetKind: 'option',
        optionType: 'call',
        strike: 300,
        expiration: '2026-06-22',
        quantity: 2,
        limitPrice: 3,
        referencePrice: 3,
      }),
      acct(),
      cfg(),
    );
    expect(failed(r)).toContain('order_notional');
  });

  it('blocks when buying power is insufficient (buys only)', () => {
    const r = evaluateGuardrails(order(), acct({ buyingPowerUsd: 50 }), cfg()); // notional 100 > 50
    expect(failed(r)).toContain('buying_power');
  });

  it('does not charge buying power to a sell', () => {
    const r = evaluateGuardrails(
      order({ side: 'sell', openClose: 'close' }),
      acct({ buyingPowerUsd: 0, currentPositionQty: 20 }),
      cfg(),
    );
    expect(check(r, 'buying_power').passed).toBe(true);
  });

  it('blocks when opening would breach the exposure ceiling', () => {
    const r = evaluateGuardrails(order(), acct({ exposureUsd: 1950 }), cfg()); // +100 -> 2050 > 2000
    expect(failed(r)).toContain('account_exposure');
  });

  it('does not count a closing order against the exposure ceiling', () => {
    const r = evaluateGuardrails(
      order({ side: 'sell', openClose: 'close' }),
      acct({ exposureUsd: 1950, currentPositionQty: 20 }),
      cfg(),
    );
    expect(check(r, 'account_exposure').passed).toBe(true);
  });

  it('blocks when the resulting position exceeds the per-symbol cap', () => {
    const r = evaluateGuardrails(order({ quantity: 10 }), acct({ currentPositionQty: 95 }), cfg()); // -> 105 > 100
    expect(failed(r)).toContain('position_size');
  });

  it('halts when the daily loss limit is hit', () => {
    const r = evaluateGuardrails(order(), acct({ realizedPnlTodayUsd: -200 }), cfg()); // loss 200 >= 200
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('daily_loss_halt');
  });

  it('does not halt below the daily loss limit', () => {
    const r = evaluateGuardrails(order(), acct({ realizedPnlTodayUsd: -199.99 }), cfg());
    expect(check(r, 'daily_loss_halt').passed).toBe(true);
  });

  it('blocks once the daily order count is reached', () => {
    const r = evaluateGuardrails(order(), acct({ ordersToday: 10 }), cfg());
    expect(failed(r)).toContain('max_orders_per_day');
  });

  it('blocks a fat-finger limit price', () => {
    const r = evaluateGuardrails(order({ limitPrice: 13, referencePrice: 10 }), acct(), cfg()); // 30% > 20%
    expect(failed(r)).toContain('fat_finger');
  });

  it('allows a limit price within the fat-finger band', () => {
    const r = evaluateGuardrails(order({ limitPrice: 11, referencePrice: 10 }), acct(), cfg()); // 10% <= 20%
    expect(check(r, 'fat_finger').passed).toBe(true);
  });

  it('blocks an order that would open a net-short position', () => {
    const r = evaluateGuardrails(order({ side: 'sell', openClose: 'open' }), acct({ currentPositionQty: 0 }), cfg());
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('naked_short');
  });

  it('allows a net-short position when explicitly enabled', () => {
    const r = evaluateGuardrails(
      order({ side: 'sell', openClose: 'open' }),
      acct({ currentPositionQty: 0 }),
      cfg({ allowNakedShort: true }),
    );
    expect(check(r, 'naked_short').passed).toBe(true);
    expect(failed(r)).not.toContain('naked_short');
  });

  it('does not flag a sell that merely reduces a long', () => {
    const r = evaluateGuardrails(order({ side: 'sell', openClose: 'close' }), acct({ currentPositionQty: 20 }), cfg());
    expect(check(r, 'naked_short').passed).toBe(true); // 20 - 10 = 10, still long
  });

  it('blocks a non-positive or fractional quantity', () => {
    expect(failed(evaluateGuardrails(order({ quantity: 0 }), acct(), cfg()))).toContain('quantity');
    expect(failed(evaluateGuardrails(order({ quantity: 1.5 }), acct(), cfg()))).toContain('quantity');
  });

  it('blocks a limit order with no limit price', () => {
    const r = evaluateGuardrails(order({ orderType: 'limit', limitPrice: undefined }), acct(), cfg());
    expect(failed(r)).toContain('limit_price');
  });

  it('fails closed when there is no usable price to value the order', () => {
    const r = evaluateGuardrails(
      order({ orderType: 'market', limitPrice: undefined, referencePrice: undefined }),
      acct(),
      cfg(),
    );
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(expect.arrayContaining(['order_notional', 'buying_power', 'account_exposure']));
  });

  it('values a market order from the reference price', () => {
    const r = evaluateGuardrails(
      order({ orderType: 'market', limitPrice: undefined, referencePrice: 10 }),
      acct(),
      cfg(),
    );
    expect(check(r, 'order_notional').passed).toBe(true);
    expect(check(r, 'fat_finger')).toBeUndefined(); // no fat-finger check for market orders
  });

  it('warns (without blocking) when the market looks closed', () => {
    const r = evaluateGuardrails(order(), acct(), cfg(), { marketOpen: false });
    expect(r.ok).toBe(true);
    expect(check(r, 'market_hours')).toMatchObject({ severity: 'warn', passed: false });
  });

  it('default config is OFF and blocks short selling', () => {
    const d = defaultTradingConfig();
    expect(d.enabled).toBe(false);
    expect(d.killSwitch).toBe(false);
    expect(d.allowNakedShort).toBe(false);
    // With defaults, even a clean order is blocked because trading is disabled.
    const r = evaluateGuardrails(order(), acct(), d);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('trading_enabled');
  });

  it('collects multiple blocking failures at once', () => {
    const r = evaluateGuardrails(
      order({ limitPrice: 1000, referencePrice: 10 }), // huge notional + fat finger
      acct({ ordersToday: 99 }),
      cfg({ killSwitch: true }),
    );
    const f = failed(r);
    expect(f).toEqual(expect.arrayContaining(['kill_switch', 'order_notional', 'fat_finger', 'max_orders_per_day']));
    expect(r.ok).toBe(false);
  });
});
