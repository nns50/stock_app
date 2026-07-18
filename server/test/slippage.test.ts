import { describe, it, expect } from 'vitest';
import { computeSlippage, aggregateSlippage, groupSlippageBySymbol } from '../src/services/slippage';

const row = (over: Partial<Parameters<typeof computeSlippage>[0]> = {}) =>
  computeSlippage({
    positionId: 1,
    symbol: 'AMC',
    kind: 'entry',
    side: 'buy',
    date: '2026-06-01',
    limitPrice: 2,
    fillPrice: 2,
    quantity: 1,
    multiplier: 1,
    ...over,
  });

describe('computeSlippage', () => {
  it('a buy filled ABOVE the limit costs you money (positive)', () => {
    const r = row({ side: 'buy', limitPrice: 2, fillPrice: 2.1, quantity: 10, multiplier: 1 });
    expect(r.perUnit).toBe(0.1);
    expect(r.totalUsd).toBe(1); // 0.1 * 10
    expect(r.pct).toBe(5); // 0.1 / 2 * 100
  });

  it('a buy filled BELOW the limit saves you money (negative)', () => {
    const r = row({ side: 'buy', limitPrice: 2, fillPrice: 1.9 });
    expect(r.perUnit).toBe(-0.1);
    expect(r.totalUsd).toBeLessThan(0);
  });

  it('a sell (closing long) filled BELOW the limit costs you money (positive)', () => {
    const r = row({ side: 'sell', kind: 'exit', limitPrice: 5, fillPrice: 4.8, quantity: 2, multiplier: 100 });
    expect(r.perUnit).toBe(0.2); // limit - fill
    expect(r.totalUsd).toBe(40); // 0.2 * 2 * 100
  });

  it('a sell filled ABOVE the limit is favorable (negative)', () => {
    const r = row({ side: 'sell', limitPrice: 5, fillPrice: 5.3 });
    expect(r.perUnit).toBe(-0.3);
  });

  it('applies the option multiplier to totalUsd', () => {
    const r = row({ side: 'buy', limitPrice: 1, fillPrice: 1.05, quantity: 3, multiplier: 100 });
    expect(r.totalUsd).toBe(15); // 0.05 * 3 * 100
  });

  it('a fill exactly at the limit has zero slippage', () => {
    const r = row({ limitPrice: 3.5, fillPrice: 3.5 });
    expect(r).toMatchObject({ perUnit: 0, totalUsd: 0, pct: 0 });
  });

  it('does not divide by zero when the limit price is 0', () => {
    const r = row({ limitPrice: 0, fillPrice: 0.5 });
    expect(r.pct).toBe(0);
    expect(r.perUnit).toBe(0.5);
  });
});

describe('aggregateSlippage', () => {
  it('sums totalUsd, averages pct, and ranks worst-first by totalUsd', () => {
    const rows = [
      row({ positionId: 1, date: '2026-06-01', limitPrice: 2, fillPrice: 2.1 }), // +0.1 = worst
      row({ positionId: 2, date: '2026-06-03', limitPrice: 2, fillPrice: 1.95 }), // -0.05 = favorable
      row({ positionId: 3, date: '2026-06-02', limitPrice: 2, fillPrice: 2.02 }), // +0.02
    ];
    const report = aggregateSlippage(rows);
    expect(report.trades).toBe(3);
    expect(report.totalUsd).toBeCloseTo(0.1 - 0.05 + 0.02, 5);
    expect(report.rows.map((r) => r.positionId)).toEqual([1, 3, 2]); // most-costly first
  });

  it('reports zero trades and null avgPct on an empty set', () => {
    const report = aggregateSlippage([]);
    expect(report).toMatchObject({ trades: 0, totalUsd: 0, avgPct: null, rows: [] });
  });
});

describe('groupSlippageBySymbol', () => {
  it('groups by symbol, averaging pct and summing totalUsd within each group', () => {
    const rows = [
      row({ symbol: 'CJMB', limitPrice: 1.2, fillPrice: 1.23 }), // pct = 2.5, totalUsd = 0.03
      row({ symbol: 'CJMB', limitPrice: 1.2, fillPrice: 1.21 }), // pct ~0.83, totalUsd = 0.01
      row({ symbol: 'AAPL', limitPrice: 150, fillPrice: 150.15 }), // pct = 0.1, totalUsd = 0.15
    ];
    const groups = groupSlippageBySymbol(rows);
    expect(groups).toHaveLength(2);
    const cjmb = groups.find((g) => g.symbol === 'CJMB')!;
    expect(cjmb.trades).toBe(2);
    expect(cjmb.avgPct).toBeCloseTo((2.5 + 0.83) / 2, 1);
    expect(cjmb.totalUsd).toBeCloseTo(0.04, 5);
  });

  it('sorts worst avgPct first', () => {
    const rows = [
      row({ symbol: 'LOW', limitPrice: 10, fillPrice: 10.05 }), // 0.5%
      row({ symbol: 'HIGH', limitPrice: 1, fillPrice: 1.03 }), // 3%
    ];
    const groups = groupSlippageBySymbol(rows);
    expect(groups.map((g) => g.symbol)).toEqual(['HIGH', 'LOW']);
  });

  it('returns an empty array for an empty input', () => {
    expect(groupSlippageBySymbol([])).toEqual([]);
  });
});
