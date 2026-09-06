import { describe, it, expect } from 'vitest';
import {
  evaluateGuardrails,
  defaultTradingConfig,
  blockingFailures,
  wouldOpenShort,
  type OrderIntent,
  type AccountState,
  type TradingConfig,
  type GuardrailReport,
} from '../src/services/trading/guardrails';
import { roundOptionPrice } from '../src/services/trading/optionTick';

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
    const r = evaluateGuardrails(order(), acct(), cfg()); // an OPEN — see the close case below
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

  it('validates bracket prices (TP above / SL below entry for a long; stocks + single-leg options)', () => {
    const good = evaluateGuardrails(
      order({ orderType: 'limit', limitPrice: 10, side: 'buy', bracket: { takeProfitPrice: 12, stopLossPrice: 9 } }),
      acct(),
      cfg(),
    );
    expect(check(good, 'bracket_prices').passed).toBe(true);

    const badTp = evaluateGuardrails(
      order({ orderType: 'limit', limitPrice: 10, side: 'buy', bracket: { takeProfitPrice: 8 } }),
      acct(),
      cfg(),
    );
    expect(failed(badTp)).toContain('bracket_prices'); // TP not above entry

    const badSl = evaluateGuardrails(
      order({ orderType: 'limit', limitPrice: 10, side: 'buy', bracket: { stopLossPrice: 11 } }),
      acct(),
      cfg(),
    );
    expect(failed(badSl)).toContain('bracket_prices'); // SL not below entry

    // A single-leg option bracket is now allowed (SL below the entry premium)…
    const optBracket = evaluateGuardrails(
      order({
        assetKind: 'option',
        optionStrategy: 'SINGLE',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 1,
        referencePrice: 1,
        multiplier: 100,
        optionType: 'call',
        strike: 100,
        expiration: '2026-07-17',
        bracket: { stopLossPrice: 0.5 },
      }),
      acct(),
      cfg(),
    );
    expect(check(optBracket, 'bracket_prices').passed).toBe(true);

    // …but a spread bracket is not.
    const spreadBracket = evaluateGuardrails(
      order({
        assetKind: 'option',
        optionStrategy: 'VERTICAL',
        quantity: 1,
        orderType: 'limit',
        limitPrice: 1,
        bracket: { stopLossPrice: 0.5 },
      }),
      acct(),
      cfg(),
    );
    expect(failed(spreadBracket)).toContain('bracket_prices');

    expect(evaluateGuardrails(order(), acct(), cfg()).checks.find((c) => c.rule === 'bracket_prices')).toBeUndefined();
  });

  it('validates a vertical spread and skips the single-leg short/position rules', () => {
    const legs = [
      { side: 'buy' as const, optionType: 'call' as const, strike: 500, expiration: '2026-07-17' },
      { side: 'sell' as const, optionType: 'call' as const, strike: 505, expiration: '2026-07-17' },
    ];
    const good = evaluateGuardrails(
      order({
        assetKind: 'option',
        optionStrategy: 'VERTICAL',
        optionLegs: legs,
        quantity: 1,
        limitPrice: 1.2,
        referencePrice: 1.2,
        multiplier: 100,
      }),
      acct(),
      cfg(),
    );
    expect(good.ok).toBe(true);
    expect(check(good, 'spread_legs').passed).toBe(true);
    // Defined-risk: the per-leg position/short rules don't apply.
    expect(good.checks.find((c) => c.rule === 'naked_short')).toBeUndefined();
    expect(good.checks.find((c) => c.rule === 'position_size')).toBeUndefined();

    // Same strikes → not a valid vertical.
    const bad = evaluateGuardrails(
      order({
        assetKind: 'option',
        optionStrategy: 'VERTICAL',
        quantity: 1,
        limitPrice: 1,
        referencePrice: 1,
        multiplier: 100,
        optionLegs: [legs[0], { ...legs[1], strike: 500 }],
      }),
      acct(),
      cfg(),
    );
    expect(failed(bad)).toContain('spread_legs');
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

  it('does not call a ONE-TICK move on a cheap option a fat finger', () => {
    // The percentage is the wrong unit at the bottom of the price scale. An
    // option under $3 quotes in nickels, so on a $0.20 mark the nearest sayable
    // price one step down is 0.15 -- 25% off, and this rule used to refuse it.
    // That is what the tick-rounding fix hit: a legitimate close, snapped to
    // the only price the broker accepts, blocked here instead of there.
    const r = evaluateGuardrails(
      order({ assetKind: 'option', limitPrice: 0.15, referencePrice: 0.2, quantity: 1 }),
      acct(),
      cfg({ fatFingerPct: 10 }),
    );
    expect(check(r, 'fat_finger').passed).toBe(true);
  });

  it('still blocks an option limit more than a tick away', () => {
    // The allowance is one tick, not a blanket pass for cheap options: two
    // nickels off a $0.20 mark is still 25% past the tick and stays a fat
    // finger.
    const r = evaluateGuardrails(
      order({ assetKind: 'option', limitPrice: 0.1, referencePrice: 0.2, quantity: 1 }),
      acct(),
      cfg({ fatFingerPct: 10 }),
    );
    expect(failed(r)).toContain('fat_finger');
  });

  it('lets a marketable buffer and the tick STACK without becoming a fat finger', () => {
    // The gap a bare sub-tick exemption leaves, and the reason the rule
    // subtracts the tick instead. The live exit path applies a 5% marketable
    // buffer and THEN snaps to the grid: a $0.31 mark buffers to 0.2945 and
    // snaps to 0.25, which is 0.06 away — more than a tick AND 19% of the
    // reference. What the order actually is, is a 5% buffer plus unavoidable
    // rounding, and 0.01 past the tick is 3%.
    const r = evaluateGuardrails(
      order({ assetKind: 'option', limitPrice: 0.25, referencePrice: 0.31, quantity: 1 }),
      acct(),
      cfg({ fatFingerPct: 10 }),
    );
    expect(check(r, 'fat_finger').passed).toBe(true);
  });

  it('clears every sub-$3 premium the live options path can produce', () => {
    // The consumer-level assertion, since the point of the tick rounding is
    // that an exit becomes PLACEABLE. Sweep every cent of premium the book can
    // hold, price it exactly the way liveOptionsExecute does — 5% marketable
    // buffer, then snap toward filling — and require the guardrail to pass it.
    // A single blocked mark here means a live position that cannot be closed,
    // which is the failure this whole change exists to end.
    for (let cents = 1; cents <= 300; cents += 1) {
      const mark = cents / 100;
      for (const [side, direction] of [
        ['sell', 'down'],
        ['buy', 'up'],
      ] as const) {
        const buffered = side === 'sell' ? mark * 0.95 : mark * 1.05;
        const limitPrice = roundOptionPrice(buffered, direction);
        if (limitPrice <= 0) continue; // validPremium's job, journaled upstream
        const r = evaluateGuardrails(
          order({ assetKind: 'option', side, openClose: 'close', limitPrice, referencePrice: mark, quantity: 1 }),
          acct({ currentPositionQty: 10 }),
          cfg({ fatFingerPct: 10 }),
        );
        expect(check(r, 'fat_finger').passed, `${side} at mark ${mark} -> ${limitPrice}`).toBe(true);
      }
    }
  });

  it('gives a stock the cent as its tick, not the nickel', () => {
    // A $0.05 stock moved one cent is 20% off and legitimate; moved a nickel it
    // is 100% off and is not.
    const near = evaluateGuardrails(
      order({ limitPrice: 0.06, referencePrice: 0.05 }),
      acct(),
      cfg({ fatFingerPct: 10 }),
    );
    expect(check(near, 'fat_finger').passed).toBe(true);
    const far = evaluateGuardrails(order({ limitPrice: 0.1, referencePrice: 0.05 }), acct(), cfg({ fatFingerPct: 10 }));
    expect(failed(far)).toContain('fat_finger');
  });

  it('blocks a fat-finger STOP-LIMIT whose limit is far from its own stop', () => {
    // Regression (hardening audit): stop_loss_limit had NO fat-finger check. The
    // limit is checked against the STOP (9 -> 13 = 44% > 20%), not the market —
    // the stop is deliberately away from the current price.
    const r = evaluateGuardrails(order({ orderType: 'stop_loss_limit', stopPrice: 9, limitPrice: 13 }), acct(), cfg());
    expect(failed(r)).toContain('fat_finger');
  });

  it('allows a stop-limit whose limit sits just past its stop', () => {
    const r = evaluateGuardrails(order({ orderType: 'stop_loss_limit', stopPrice: 9, limitPrice: 8.9 }), acct(), cfg()); // 1.1% <= 20%
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

  describe('wouldOpenShort (order-side mapping for the Webull SHORT vs SELL distinction)', () => {
    it('is true for a sell that would open a net-short position', () => {
      expect(wouldOpenShort(order({ side: 'sell', quantity: 10 }), acct({ currentPositionQty: 0 }))).toBe(true);
    });

    it('is true for a sell that extends an already-short position', () => {
      expect(wouldOpenShort(order({ side: 'sell', quantity: 10 }), acct({ currentPositionQty: -5 }))).toBe(true);
    });

    it('is false for a sell that only reduces a long (same as the naked_short check above)', () => {
      expect(wouldOpenShort(order({ side: 'sell', quantity: 10 }), acct({ currentPositionQty: 20 }))).toBe(false);
    });

    it('is false for a sell that exactly flattens a long to zero', () => {
      expect(wouldOpenShort(order({ side: 'sell', quantity: 10 }), acct({ currentPositionQty: 10 }))).toBe(false);
    });

    it('is false for any buy, regardless of current position', () => {
      expect(wouldOpenShort(order({ side: 'buy', quantity: 10 }), acct({ currentPositionQty: -5 }))).toBe(false);
    });
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

  it('warns (without blocking) when a buy exceeds settled cash (Good Faith Violation risk)', () => {
    const r = evaluateGuardrails(
      order({ orderType: 'limit', limitPrice: 10, quantity: 10 }), // $100 notional
      acct({ buyingPowerUsd: 100_000, settledCashUsd: 50 }),
      cfg(),
    );
    expect(r.ok).toBe(true);
    expect(check(r, 'settled_cash')).toMatchObject({ severity: 'warn', passed: false });
  });

  it('passes settled_cash silently when the buy is within settled cash', () => {
    const r = evaluateGuardrails(
      order({ orderType: 'limit', limitPrice: 10, quantity: 10 }), // $100 notional
      acct({ settledCashUsd: 1000 }),
      cfg(),
    );
    expect(check(r, 'settled_cash')).toMatchObject({ severity: 'warn', passed: true });
  });

  it('skips settled_cash entirely when the broker did not report it (not a fabricated warning)', () => {
    const r = evaluateGuardrails(order(), acct(), cfg()); // acct() leaves settledCashUsd undefined
    expect(check(r, 'settled_cash')).toBeUndefined();
  });

  it('never checks settled_cash on a sell (selling frees cash, no GFV risk)', () => {
    const r = evaluateGuardrails(
      order({ side: 'sell', openClose: 'close' }),
      acct({ settledCashUsd: 0, currentPositionQty: 10 }),
      cfg(),
    );
    expect(check(r, 'settled_cash')).toBeUndefined();
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

describe('spread_account_type (spreads require a margin account)', () => {
  const vertical = (over: Partial<OrderIntent> = {}): OrderIntent =>
    order({
      assetKind: 'option',
      optionStrategy: 'VERTICAL',
      quantity: 1,
      limitPrice: 0.5,
      referencePrice: undefined,
      optionLegs: [
        { side: 'buy', optionType: 'call', strike: 6, expiration: '2026-07-17' },
        { side: 'sell', optionType: 'call', strike: 7, expiration: '2026-07-17' },
      ],
      ...over,
    });

  it('blocks a spread on a cash account', () => {
    const r = evaluateGuardrails(vertical(), acct({ accountType: 'INDIVIDUAL_CASH' }), cfg());
    expect(check(r, 'spread_account_type').passed).toBe(false);
    expect(failed(r)).toContain('spread_account_type');
  });

  it('allows a spread on a margin account', () => {
    const r = evaluateGuardrails(vertical(), acct({ accountType: 'INDIVIDUAL_MARGIN' }), cfg());
    expect(check(r, 'spread_account_type').passed).toBe(true);
    expect(failed(r)).not.toContain('spread_account_type');
  });

  it('omits the check when the account type is unknown (broker stays the gate)', () => {
    const r = evaluateGuardrails(vertical(), acct(), cfg());
    expect(r.checks.find((c) => c.rule === 'spread_account_type')).toBeUndefined();
  });

  it('does not apply to single-leg option orders', () => {
    const single = order({
      assetKind: 'option',
      optionStrategy: 'SINGLE',
      optionType: 'call',
      strike: 6,
      expiration: '2026-07-17',
      limitPrice: 0.5,
      referencePrice: undefined,
    });
    const r = evaluateGuardrails(single, acct({ accountType: 'INDIVIDUAL_CASH' }), cfg());
    expect(r.checks.find((c) => c.rule === 'spread_account_type')).toBeUndefined();
  });
});

describe('covered_legs (covered call shape)', () => {
  const covered = (over: Partial<OrderIntent> = {}): OrderIntent =>
    order({
      assetKind: 'option',
      optionStrategy: 'COVERED',
      quantity: 1,
      limitPrice: 1.5,
      referencePrice: undefined,
      optionLegs: [{ side: 'sell', optionType: 'call', strike: 105, expiration: '2026-07-17' }],
      ...over,
    });

  it('accepts a single short-call leg and treats the combo as defined-risk', () => {
    const r = evaluateGuardrails(covered(), acct(), cfg());
    expect(check(r, 'covered_legs').passed).toBe(true);
    // Defined-risk: the single-leg position/short rules are skipped.
    expect(r.checks.find((c) => c.rule === 'position_size')).toBeUndefined();
    expect(r.checks.find((c) => c.rule === 'naked_short')).toBeUndefined();
  });

  it('rejects anything but one SELL CALL leg', () => {
    const buyCall = covered({
      optionLegs: [{ side: 'buy', optionType: 'call', strike: 105, expiration: '2026-07-17' }],
    });
    const sellPut = covered({
      optionLegs: [{ side: 'sell', optionType: 'put', strike: 105, expiration: '2026-07-17' }],
    });
    expect(check(evaluateGuardrails(buyCall, acct(), cfg()), 'covered_legs').passed).toBe(false);
    expect(check(evaluateGuardrails(sellPut, acct(), cfg()), 'covered_legs').passed).toBe(false);
  });
});

describe('iron_condor_legs (4-leg condor shape + margin gate)', () => {
  const condor = (over: Partial<OrderIntent> = {}): OrderIntent =>
    order({
      assetKind: 'option',
      optionStrategy: 'IRON_CONDOR',
      side: 'sell', // net credit
      quantity: 1,
      limitPrice: 0.8,
      referencePrice: undefined,
      optionLegs: [
        { side: 'sell', optionType: 'put', strike: 95, expiration: '2026-07-17' },
        { side: 'buy', optionType: 'put', strike: 90, expiration: '2026-07-17' },
        { side: 'sell', optionType: 'call', strike: 110, expiration: '2026-07-17' },
        { side: 'buy', optionType: 'call', strike: 115, expiration: '2026-07-17' },
      ],
      ...over,
    });

  it('accepts a valid 4-leg condor and treats it as defined-risk', () => {
    const r = evaluateGuardrails(condor(), acct({ accountType: 'INDIVIDUAL_MARGIN' }), cfg());
    expect(check(r, 'iron_condor_legs').passed).toBe(true);
    expect(r.checks.find((c) => c.rule === 'position_size')).toBeUndefined();
    expect(r.checks.find((c) => c.rule === 'naked_short')).toBeUndefined();
  });

  it('rejects a malformed condor (not 2 calls + 2 puts)', () => {
    const bad = condor({
      optionLegs: [
        { side: 'sell', optionType: 'call', strike: 95, expiration: '2026-07-17' },
        { side: 'buy', optionType: 'call', strike: 90, expiration: '2026-07-17' },
        { side: 'sell', optionType: 'call', strike: 110, expiration: '2026-07-17' },
        { side: 'buy', optionType: 'call', strike: 115, expiration: '2026-07-17' },
      ],
    });
    expect(
      check(evaluateGuardrails(bad, acct({ accountType: 'INDIVIDUAL_MARGIN' }), cfg()), 'iron_condor_legs').passed,
    ).toBe(false);
  });

  it('requires a margin account (blocks on cash/IRA, like a vertical)', () => {
    expect(failed(evaluateGuardrails(condor(), acct({ accountType: 'INDIVIDUAL_CASH' }), cfg()))).toContain(
      'spread_account_type',
    );
    expect(failed(evaluateGuardrails(condor(), acct({ accountType: 'INDIVIDUAL_MARGIN' }), cfg()))).not.toContain(
      'spread_account_type',
    );
  });
});

// ---------------------------------------------------------------------------
// The daily order cap is a runaway-loop backstop, and a runaway loop places
// ENTRIES. Refusing an EXIT does not limit risk — it strands you in a position.
// Live evidence two days running:
//   2026-08-24  GRMN's exit refused 44 times on "4 placed vs 4/day", carried
//               overnight, closed next morning at -$11.31.
//   2026-08-25  IT's exit refused 36 times from 13:57 to 15:23 while the
//               position slid from -$11.41 to -$23.94.
// Every risk the cap is nominally about is already held elsewhere: entries by
// maxTradesPerDay, exposure by concurrent-position/aggregate-risk/buying-power,
// a bad day by the drawdown halt.
// ---------------------------------------------------------------------------
describe('max_orders_per_day never blocks a close', () => {
  /** Cap long spent, and a real 10-share long on the books to close. */
  const spent = () => acct({ ordersToday: 999, currentPositionQty: 10 });

  it('blocks an OPEN once the cap is spent', () => {
    const r = evaluateGuardrails(order({ openClose: 'open' }), spent(), cfg({ maxOrdersPerDay: 4 }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('max_orders_per_day');
  });

  it('lets a CLOSE through with the cap long spent — either side', () => {
    const sell = evaluateGuardrails(order({ openClose: 'close', side: 'sell' }), spent(), cfg({ maxOrdersPerDay: 4 }));
    expect(failed(sell)).not.toContain('max_orders_per_day');
    expect(sell.ok).toBe(true);

    // Closing a SHORT is a buy, and must be just as unblockable.
    const buyToCover = evaluateGuardrails(
      order({ openClose: 'close', side: 'buy' }),
      acct({ ordersToday: 999, currentPositionQty: -10 }),
      cfg({ maxOrdersPerDay: 4 }),
    );
    expect(failed(buyToCover)).not.toContain('max_orders_per_day');
  });

  it('omits the rule entirely from a close breakdown rather than reporting a pass it never made', () => {
    const r = evaluateGuardrails(order({ openClose: 'close' }), spent(), cfg({ maxOrdersPerDay: 4 }));
    expect(r.checks.find((c) => c.rule === 'max_orders_per_day')).toBeUndefined();
  });

  it('still blocks a close on rules that are actually about risk', () => {
    // Exempting the ORDER CAP must not exempt closes from everything — the kill
    // switch still stops a close, because that is a deliberate full stop.
    const r = evaluateGuardrails(order({ openClose: 'close' }), spent(), cfg({ killSwitch: true }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('kill_switch');
  });
});

// A naked SHORT is an OPENING sell: it consumes margin. The buying-power rule
// used to key on `side` and wave every sell through as "frees cash" — true of
// closing a long, false of opening a short. Inert only while
// liveAllowNakedShort was off; live money the moment it was switched on.
describe('buying_power — opening vs closing, not buy vs sell', () => {
  it('REFUSES a short entry that exceeds buying power', () => {
    const r = evaluateGuardrails(
      order({ side: 'sell', openClose: 'open', quantity: 100, limitPrice: 50 }),
      acct({ buyingPowerUsd: 1_000 }),
      cfg({ allowNakedShort: true, maxOrderUsd: 1_000_000 }),
    );
    expect(check(r, 'buying_power').passed).toBe(false); // $5,000 vs $1,000
  });

  it('still waves a CLOSING sell through', () => {
    const r = evaluateGuardrails(
      order({ side: 'sell', openClose: 'close', quantity: 100, limitPrice: 50 }),
      acct({ buyingPowerUsd: 1_000 }),
      cfg({ allowNakedShort: true, maxOrderUsd: 1_000_000 }),
    );
    expect(check(r, 'buying_power').passed).toBe(true);
    expect(check(r, 'buying_power').detail).toMatch(/closing frees/);
  });

  it('a long entry is unchanged by the fix', () => {
    const r = evaluateGuardrails(
      order({ side: 'buy', openClose: 'open', quantity: 100, limitPrice: 50 }),
      acct({ buyingPowerUsd: 1_000 }),
      cfg({ maxOrderUsd: 1_000_000 }),
    );
    expect(check(r, 'buying_power').passed).toBe(false);
  });
});
