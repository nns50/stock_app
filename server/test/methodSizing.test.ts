import { describe, it, expect } from 'vitest';
import type { Position } from '../src/db/positions';
import {
  RECENT_TRADES_PER_METHOD,
  computeMethodMultipliers,
  computeMethodPerformance,
  methodOf,
  methodOfEquitySignal,
  methodOfOptionsSignal,
} from '../src/services/autotrading/methodSizing';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';

// A minimal closed position: entry 100, stop 95 (risk 5/share), one full exit.
// exitPrice 110 => realizedR +2; exitPrice 95 => realizedR -1.
let idSeq = 0;
function closed(over: Partial<Position> & { exitPrice?: number; exitDate?: string } = {}): Position {
  const { exitPrice = 110, exitDate = '2026-08-20', ...rest } = over;
  idSeq += 1;
  return {
    id: idSeq,
    assetType: 'stock',
    symbol: 'AAPL',
    side: 'long',
    quantity: 1,
    remainingQuantity: 0,
    entryPrice: 100,
    entryDate: '2026-08-01',
    stopPrice: 95,
    targetPrice: null,
    optionType: null,
    strike: null,
    expiration: null,
    multiplier: 1,
    fees: 0,
    notes: null,
    tags: ['autotrade'],
    grade: null,
    status: 'closed',
    accountId: null,
    sourceIntentId: null,
    exitReason: null,
    marketRegimeAtEntry: null,
    exits: [{ id: idSeq, positionId: idSeq, quantity: 1, exitPrice, exitDate, fees: 0, notes: null, createdAt: 0 }],
    createdAt: 0,
    ...rest,
  } as Position;
}

const cfgOn = {
  ...defaultAutotradeConfig(),
  methodWeightingEnabled: true,
  expectancyMinTrades: 3,
  expectancyMinMultiplier: 0.5,
  expectancyMaxMultiplier: 1.5,
};

describe('methodOf', () => {
  it('classifies the four buckets and rejects the unclassifiable', () => {
    expect(methodOf({ assetType: 'stock', side: 'long', optionType: null })).toBe('stock_long');
    expect(methodOf({ assetType: 'stock', side: 'short', optionType: null })).toBe('stock_short');
    expect(methodOf({ assetType: 'option', side: 'long', optionType: 'call' })).toBe('option_call');
    expect(methodOf({ assetType: 'option', side: 'long', optionType: 'put' })).toBe('option_put');
    expect(methodOf({ assetType: 'option', side: 'long', optionType: null })).toBeNull();
  });

  it('maps signals the same way the journal classifies the resulting position', () => {
    expect(methodOfEquitySignal('buy')).toBe('stock_long');
    expect(methodOfEquitySignal('sell')).toBe('stock_short');
    expect(methodOfOptionsSignal('call')).toBe('option_call');
    expect(methodOfOptionsSignal('put')).toBe('option_put');
  });
});

describe('computeMethodMultipliers', () => {
  it('is empty when method weighting is off — every method reads 1× (neutral)', () => {
    const trades = [closed(), closed(), closed(), closed()];
    expect(computeMethodMultipliers(trades, { ...cfgOn, methodWeightingEnabled: false })).toEqual({});
  });

  it('leans UP on a method with proven positive recent R, DOWN on a bleeding one', () => {
    const winners = [closed(), closed(), closed()]; // stock_long, +2R each
    const losers = [
      closed({ assetType: 'option', optionType: 'put', exitPrice: 95 }),
      closed({ assetType: 'option', optionType: 'put', exitPrice: 95 }),
      closed({ assetType: 'option', optionType: 'put', exitPrice: 95 }),
    ]; // option_put, -1R each
    const m = computeMethodMultipliers([...winners, ...losers], cfgOn);
    expect(m.stock_long).toBe(1.5); // clamp(1 + 2, 0.5, 1.5)
    expect(m.option_put).toBe(0.5); // clamp(1 - 1, 0.5, 1.5) — leaned down, never off
  });

  it('an unproven method (below the sample floor) is absent — the caller reads 1×', () => {
    const m = computeMethodMultipliers([closed(), closed()], cfgOn); // 2 < minTrades 3
    expect(m.stock_long).toBeUndefined();
  });

  it('judges each method on its RECENT trades only — old-regime history ages out', () => {
    // 20 recent winners then, older than all of them, 30 losers from a
    // previous config era. The window must see only the winners.
    const recent = Array.from({ length: RECENT_TRADES_PER_METHOD }, (_, i) =>
      closed({ exitDate: `2026-08-${String(i + 1).padStart(2, '0')}` }),
    );
    const ancient = Array.from({ length: 30 }, () => closed({ exitPrice: 95, exitDate: '2026-05-01' }));
    const m = computeMethodMultipliers([...ancient, ...recent], cfgOn);
    expect(m.stock_long).toBe(1.5); // avg +2R over the recent 20, losers invisible
  });

  it('drops trades with no usable risk or date rather than guessing an R', () => {
    const noRisk = closed({ stopPrice: null });
    const noDate = closed();
    noDate.exits = [];
    expect(computeMethodMultipliers([noRisk, noDate, closed(), closed()], cfgOn).stock_long).toBeUndefined(); // only 2 usable < 3
  });
});

describe('computeMethodPerformance (dashboard)', () => {
  it('reports every traded bucket with its record and the multiplier in force', () => {
    const trades = [closed(), closed(), closed(), closed({ assetType: 'option', optionType: 'call', exitPrice: 95 })];
    const perf = computeMethodPerformance(trades, cfgOn as never);
    const byMethod = Object.fromEntries(perf.map((p) => [p.method, p]));
    expect(byMethod.stock_long).toMatchObject({ n: 3, wins: 3, avgR: 2, multiplier: 1.5 });
    // option_call has 1 trade: visible in the ledger, but below the floor — 1×.
    expect(byMethod.option_call).toMatchObject({ n: 1, wins: 0, avgR: -1, multiplier: 1 });
  });

  it('with weighting off the ledger still reports — evidence before action', () => {
    const perf = computeMethodPerformance([closed(), closed(), closed()], {
      ...cfgOn,
      methodWeightingEnabled: false,
    } as never);
    expect(perf[0]).toMatchObject({ method: 'stock_long', n: 3, multiplier: 1 });
  });
});
