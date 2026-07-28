import { describe, it, expect } from 'vitest';
import { buildPositionExitAlerts, buildStopTargetAlerts } from '../src/services/positionExits';
import { defaultExitConfig } from '../src/options/exitRules';
import type { Position } from '../src/db/positions';

function opt(over: Partial<Position>): Position {
  return {
    id: 1,
    assetType: 'option',
    symbol: 'AAPL',
    side: 'long',
    quantity: 1,
    entryPrice: 1,
    entryDate: '2026-06-01',
    fees: 0,
    optionType: 'call',
    strike: 200,
    expiration: '2026-12-31',
    multiplier: 100,
    status: 'open',
    tags: [],
    grade: null,
    notes: null,
    checklist: [],
    stopPrice: null,
    targetPrice: null,
    entryTime: null,
    sourceIntentId: null,
    accountId: null,
    entryScore: null,
    marketRegime: null,
    marketAtrPct: null,
    createdAt: 0,
    updatedAt: 0,
    exits: [],
    remainingQuantity: 1,
    ...over,
  };
}

describe('buildPositionExitAlerts', () => {
  const now = new Date('2026-06-13T00:00:00Z');
  const cfg = defaultExitConfig(); // TP 50% / SL 50% / time 7d

  const positions = [opt({ id: 1, strike: 200 }), opt({ id: 2, strike: 210 }), opt({ id: 3, strike: 220 })];
  const marks = new Map<number, { mark: number | null; delta: number | null }>([
    [1, { mark: 1.6, delta: 0.6 }], // +60% -> take-profit
    [2, { mark: 0.4, delta: 0.3 }], // -60% -> stop-loss
    [3, { mark: null, delta: null }], // no mark -> nothing
  ]);
  const alerts = buildPositionExitAlerts(positions, (p) => marks.get(p.id) ?? { mark: null, delta: null }, cfg, now);

  it('flags take-profit and stop-loss, ignores positions without a mark', () => {
    expect(alerts.map((a) => a.positionId).sort()).toEqual([1, 2]);
    expect(alerts.find((a) => a.positionId === 1)!.rule).toBe('take-profit');
    expect(alerts.find((a) => a.positionId === 2)!.rule).toBe('stop-loss');
  });

  it('formats a human message with symbol, contract and return %', () => {
    const a = alerts.find((x) => x.positionId === 1)!;
    expect(a.message).toBe('AAPL 200C: take-profit (+60.0%)');
  });

  it('fires the time-exit rule near expiry', () => {
    const soon = [opt({ id: 9, expiration: '2026-06-15' })]; // 2 days out, < 7
    const a = buildPositionExitAlerts(soon, () => ({ mark: 1.05, delta: 0.5 }), cfg, now);
    expect(a[0].rule).toBe('time-exit');
  });
});

describe('buildStopTargetAlerts', () => {
  const stock = (over: Partial<Position>) => opt({ assetType: 'stock', optionType: null, strike: null, ...over });

  it('fires stop-hit / target-hit by side, and nothing in between', () => {
    const positions = [
      stock({ id: 1, side: 'long', entryPrice: 100, stopPrice: 95, targetPrice: 110 }),
      stock({ id: 2, side: 'short', entryPrice: 100, stopPrice: 105, targetPrice: 90 }),
      stock({ id: 3, side: 'long', entryPrice: 100, stopPrice: 95, targetPrice: 110 }),
    ];
    const price = new Map<number, number>([
      [1, 94], // long below stop -> stop-hit
      [2, 106], // short above stop -> stop-hit
      [3, 102], // between -> nothing
    ]);
    const alerts = buildStopTargetAlerts(positions, (p) => price.get(p.id) ?? null);
    expect(alerts.map((a) => `${a.positionId}:${a.rule}`).sort()).toEqual(['1:stop-hit', '2:stop-hit']);
  });

  it('fires target-hit for a long reaching its target', () => {
    const a = buildStopTargetAlerts([stock({ id: 5, side: 'long', entryPrice: 100, targetPrice: 110 })], () => 112);
    expect(a[0].rule).toBe('target-hit');
    expect(a[0].message).toContain('target $110');
  });

  it('ignores positions without a price or without levels', () => {
    const positions = [
      stock({ id: 6, stopPrice: 95 }), // no price
      stock({ id: 7 }), // no levels
    ];
    expect(buildStopTargetAlerts(positions, (p) => (p.id === 7 ? 50 : null))).toEqual([]);
  });
});
