import { describe, it, expect } from 'vitest';
import { computeEquityCurveDerisk } from '../src/services/autotrading/equityCurveDerisk';

const ON = { enabled: true, lookbackDays: 3, cutPct: 50 };

describe('computeEquityCurveDerisk', () => {
  it('is inactive (multiplier 1) when disabled', () => {
    const trades = [
      { date: '2026-08-01', pnl: 10 },
      { date: '2026-08-02', pnl: -30 },
      { date: '2026-08-03', pnl: -30 },
      { date: '2026-08-04', pnl: -30 },
    ];
    const r = computeEquityCurveDerisk(trades, { ...ON, enabled: false });
    expect(r.active).toBe(false);
    expect(r.multiplier).toBe(1);
    expect(r.reason).toMatch(/disabled/);
  });

  it('is inactive below the lookback history floor', () => {
    const trades = [
      { date: '2026-08-01', pnl: 10 },
      { date: '2026-08-02', pnl: -30 }, // only 2 days, need 3
    ];
    const r = computeEquityCurveDerisk(trades, ON);
    expect(r.active).toBe(false);
    expect(r.multiplier).toBe(1);
    expect(r.reason).toMatch(/insufficient history \(2 days, need 3\)/);
  });

  it('de-risks when the cumulative curve is below its N-day average', () => {
    // cumulative: 10, 20, -10 → avg of last 3 = 6.67, latest −10 < avg → active.
    const trades = [
      { date: '2026-08-01', pnl: 10 },
      { date: '2026-08-02', pnl: 10 },
      { date: '2026-08-03', pnl: -30 },
    ];
    const r = computeEquityCurveDerisk(trades, ON);
    expect(r.active).toBe(true);
    expect(r.multiplier).toBe(0.5); // 1 − 50%
    expect(r.latest).toBe(-10);
    expect(r.days).toBe(3);
  });

  it('restores full size when the curve is at/above its average', () => {
    // cumulative: −10, −5, 15 → avg 0, latest 15 ≥ avg → inactive.
    const trades = [
      { date: '2026-08-01', pnl: -10 },
      { date: '2026-08-02', pnl: 5 },
      { date: '2026-08-03', pnl: 20 },
    ];
    const r = computeEquityCurveDerisk(trades, ON);
    expect(r.active).toBe(false);
    expect(r.multiplier).toBe(1);
  });

  it('buckets multiple trades on the same day into one curve point', () => {
    // day1: +5 +5 = cum 10; day2: −30 = cum −20. lookback 2 → avg −5, latest −20 → active.
    const trades = [
      { date: '2026-08-01', pnl: 5 },
      { date: '2026-08-01', pnl: 5 },
      { date: '2026-08-02', pnl: -30 },
    ];
    const r = computeEquityCurveDerisk(trades, { enabled: true, lookbackDays: 2, cutPct: 40 });
    expect(r.days).toBe(2);
    expect(r.active).toBe(true);
    expect(r.multiplier).toBe(0.6);
  });

  it('clamps the multiplier to [0,1] at an extreme cut', () => {
    const trades = [
      { date: '2026-08-01', pnl: 10 },
      { date: '2026-08-02', pnl: 10 },
      { date: '2026-08-03', pnl: -30 },
    ];
    const r = computeEquityCurveDerisk(trades, { enabled: true, lookbackDays: 3, cutPct: 100 });
    expect(r.active).toBe(true);
    expect(r.multiplier).toBe(0); // 1 − 100%, floored at 0
  });
});
