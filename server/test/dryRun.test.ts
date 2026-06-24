import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, db } from '../src/db';
import { dryRunOrder } from '../src/services/trading/dryRun';
import { setTradingConfig } from '../src/db/trading';
import { getEvents } from '../src/db/orders';
import type { AccountState, OrderIntent } from '../src/services/trading/guardrails';

beforeAll(() => initDb());
beforeEach(() => db.exec('DELETE FROM order_events; DELETE FROM order_intents; DELETE FROM trading_config;'));

const account: AccountState = {
  buyingPowerUsd: 100_000,
  exposureUsd: 0,
  realizedPnlTodayUsd: 0,
  ordersToday: 0,
  currentPositionQty: 0,
};
const smallBuy: OrderIntent = {
  symbol: 'AAPL',
  assetKind: 'stock',
  side: 'buy',
  openClose: 'open',
  quantity: 10,
  orderType: 'limit',
  limitPrice: 10,
  referencePrice: 10,
};

describe('dry-run order pipeline', () => {
  it('validates a clean order and never submits', () => {
    setTradingConfig({ enabled: true });
    const r = dryRunOrder(smallBuy, account, 'k1');
    expect(r.wouldSubmit).toBe(true);
    expect(r.intent.state).toBe('validated');
    expect(r.notional).toBe(100);
    expect(r.summary).toMatch(/would submit/i);
    // Stops before submission: only draft -> validated in the audit trail.
    expect(getEvents(r.intent.id).map((e) => e.state)).toEqual(['draft', 'validated']);
  });

  it('rejects when trading is disabled (default off)', () => {
    const r = dryRunOrder(smallBuy, account, 'k1'); // default config: enabled = false
    expect(r.wouldSubmit).toBe(false);
    expect(r.intent.state).toBe('rejected');
    expect(r.guardrails.checks.find((c) => c.rule === 'trading_enabled')!.passed).toBe(false);
    expect(getEvents(r.intent.id).map((e) => e.state)).toEqual(['draft', 'rejected']);
  });

  it('rejects on the kill switch even when enabled', () => {
    setTradingConfig({ enabled: true, killSwitch: true });
    const r = dryRunOrder(smallBuy, account, 'k1');
    expect(r.wouldSubmit).toBe(false);
    expect(r.intent.state).toBe('rejected');
    expect(r.guardrails.checks.find((c) => c.rule === 'kill_switch')!.passed).toBe(false);
  });

  it('honors persisted caps (notional over cap blocks)', () => {
    setTradingConfig({ enabled: true, maxOrderUsd: 50 }); // 10 × $10 = $100 > $50
    const r = dryRunOrder(smallBuy, account, 'k1');
    expect(r.wouldSubmit).toBe(false);
    expect(r.guardrails.checks.find((c) => c.rule === 'order_notional')!.passed).toBe(false);
  });

  it('is idempotent on the client key (no re-transition)', () => {
    setTradingConfig({ enabled: true });
    const a = dryRunOrder(smallBuy, account, 'k1');
    const b = dryRunOrder(smallBuy, account, 'k1');
    expect(b.intent.id).toBe(a.intent.id);
    expect(getEvents(a.intent.id).map((e) => e.state)).toEqual(['draft', 'validated']);
  });

  it('values an option order with the contract multiplier', () => {
    setTradingConfig({ enabled: true, maxOrderUsd: 100_000 });
    const optBuy: OrderIntent = {
      symbol: 'AAPL',
      assetKind: 'option',
      optionType: 'call',
      strike: 300,
      expiration: '2026-06-22',
      side: 'buy',
      openClose: 'open',
      quantity: 2,
      orderType: 'limit',
      limitPrice: 3,
      referencePrice: 3,
    };
    const r = dryRunOrder(optBuy, account, 'k1');
    expect(r.notional).toBe(600); // 2 × 100 × $3
    expect(r.wouldSubmit).toBe(true);
    expect(r.summary).toContain('call');
  });
});
