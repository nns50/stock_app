import { describe, it, expect } from 'vitest';
import {
  aggregateStopOverruns,
  classifyStopExit,
  computeStopOverrun,
  StopOverrunInput,
} from '../src/services/stopOverrun';

const input = (overrides: Partial<StopOverrunInput> = {}): StopOverrunInput => ({
  positionId: 1,
  symbol: 'TEST',
  side: 'long',
  date: '2026-07-01',
  entryPrice: 10,
  stopPrice: 9,
  exitPrice: 8.8,
  quantity: 100,
  basis: 'recorded',
  ...overrides,
});

describe('classifyStopExit', () => {
  it("trusts a recorded 'stop' reason regardless of where the exit landed", () => {
    expect(classifyStopExit('long', 9, 9.5, 'stop')).toBe('recorded'); // better than stop, still a stop execution
    expect(classifyStopExit('long', 9, 8.5, 'stop')).toBe('recorded');
  });

  it('infers a stop only for a REASONLESS exit at-or-beyond the declared stop', () => {
    expect(classifyStopExit('long', 9, 8.8, null)).toBe('inferred');
    expect(classifyStopExit('long', 9, 9, null)).toBe('inferred'); // exactly at the stop
    expect(classifyStopExit('long', 9, 9.5, null)).toBeNull(); // above the stop — not a stop exit
    expect(classifyStopExit('short', 10, 10.2, null)).toBe('inferred');
    expect(classifyStopExit('short', 10, 9.5, null)).toBeNull();
  });

  it('never counts an exit with a DIFFERENT recorded reason, even beyond the stop', () => {
    expect(classifyStopExit('long', 9, 8.5, 'manual')).toBeNull(); // panic sale is a decision, not an execution
    expect(classifyStopExit('long', 9, 8.5, 'time_exit')).toBeNull();
    expect(classifyStopExit('long', 9, 8.5, 'target')).toBeNull();
  });
});

describe('computeStopOverrun', () => {
  it('signs a long stop overrun positive when the exit lands BELOW the stop', () => {
    const row = computeStopOverrun(input()); // stop 9, exited 8.80, risk/share $1
    expect(row.overrunPerShare).toBe(0.2);
    expect(row.overrunPct).toBeCloseTo(2.22, 2);
    expect(row.overrunR).toBe(0.2); // a fifth of the planned 1R, extra
    expect(row.totalUsd).toBe(20);
  });

  it('signs a short stop overrun positive when the exit lands ABOVE the stop', () => {
    const row = computeStopOverrun(input({ side: 'short', entryPrice: 9, stopPrice: 10, exitPrice: 10.5 }));
    expect(row.overrunPerShare).toBe(0.5);
    expect(row.overrunR).toBe(0.5);
    expect(row.totalUsd).toBe(50);
  });

  it('keeps a better-than-stop fill negative (favorable), not clamped to zero', () => {
    const row = computeStopOverrun(input({ exitPrice: 9.1 }));
    expect(row.overrunPerShare).toBe(-0.1);
    expect(row.totalUsd).toBe(-10);
  });

  it('reports overrunR null when entry equals stop (zero declared risk distance)', () => {
    const row = computeStopOverrun(input({ entryPrice: 9, stopPrice: 9, exitPrice: 8.5 }));
    expect(row.overrunR).toBeNull();
    expect(row.overrunPerShare).toBe(0.5); // $ math still works
  });
});

describe('aggregateStopOverruns', () => {
  it('summarizes counts, medians, R averages, and sorts rows most costly first', () => {
    const rows = [
      computeStopOverrun(input({ positionId: 1, exitPrice: 8.8 })), // +0.2/sh, $20
      computeStopOverrun(input({ positionId: 2, exitPrice: 9, basis: 'inferred' })), // exactly at stop
      computeStopOverrun(input({ positionId: 3, exitPrice: 8.5, quantity: 10 })), // +0.5/sh, $5
    ];
    const report = aggregateStopOverruns(rows);
    expect(report.trades).toBe(3);
    expect(report.recorded).toBe(2);
    expect(report.inferred).toBe(1);
    expect(report.beyondCount).toBe(2); // exactly-at-stop is not "beyond"
    expect(report.beyondPct).toBeCloseTo(66.67, 1);
    expect(report.totalUsd).toBe(25);
    expect(report.avgOverrunR).toBeCloseTo(0.23, 2); // (0.2 + 0 + 0.5) / 3
    expect(report.rows.map((r) => r.positionId)).toEqual([1, 3, 2]); // by $ cost desc
  });

  it('buckets by ENTRY price band, the micro-cap tax dimension', () => {
    const rows = [
      computeStopOverrun(input({ positionId: 1, entryPrice: 3, stopPrice: 2.7, exitPrice: 2.4 })), // <$5, +0.3
      computeStopOverrun(input({ positionId: 2, entryPrice: 3.5, stopPrice: 3.2, exitPrice: 3.2 })), // <$5, at stop
      computeStopOverrun(input({ positionId: 3, entryPrice: 100, stopPrice: 97, exitPrice: 96.9 })), // ≥$50
    ];
    const report = aggregateStopOverruns(rows);
    const byLabel = new Map(report.bands.map((b) => [b.label, b]));
    expect(byLabel.get('<$5')).toMatchObject({ trades: 2, beyondPct: 50 });
    expect(byLabel.get('$5–15')).toMatchObject({ trades: 0, beyondPct: null, avgOverrunR: null });
    expect(byLabel.get('≥$50')!.trades).toBe(1);
    expect(byLabel.get('≥$50')!.avgOverrunR).toBeCloseTo(0.03, 2); // 0.10 over a $3 risk distance
  });

  it('returns an all-null/zero report for no rows', () => {
    const report = aggregateStopOverruns([]);
    expect(report.trades).toBe(0);
    expect(report.beyondPct).toBeNull();
    expect(report.medianOverrunPct).toBeNull();
    expect(report.avgOverrunR).toBeNull();
    expect(report.totalUsd).toBe(0);
  });
});
