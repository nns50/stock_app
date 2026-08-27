import { describe, it, expect } from 'vitest';
import { detectExternalCashFlow } from '../src/services/autotrading/externalCashFlow';

// The real 2026-08-27 session: a $2,228.83 baseline, a $5,000 deposit, and
// -$2,067.64 of manual trading. Equity ended at $5,161.18 and the day read
// +131.56% — banking itself and halting live entries on a session whose actual
// autotrade P&L was -$8.32.
const BASELINE = 2_228.83;

describe('detectExternalCashFlow', () => {
  it('catches the deposit that banked a fictional day', () => {
    // Equity as the guard finally accepted it, against the broker's own day P&L.
    const flow = detectExternalCashFlow({
      baselineUsd: BASELINE,
      currentEquityUsd: 5_352.23,
      brokerDayPnlUsd: -2_067.64,
    });
    expect(flow).not.toBeNull();
    // baseline 2228.83 + dayPnl -2067.64 = 161.19 explained; the rest is cash.
    expect(flow!.flowUsd).toBeCloseTo(5_191.04, 2);
    expect(flow!.adjustedBaselineUsd).toBeCloseTo(7_419.87, 2);
    expect(flow!.reason).toMatch(/deposit/);
  });

  it('re-bases so the day reads its TRADING result, not the deposit', () => {
    const flow = detectExternalCashFlow({
      baselineUsd: BASELINE,
      currentEquityUsd: 5_352.23,
      brokerDayPnlUsd: -2_067.64,
    })!;
    const before = ((5_352.23 - BASELINE) / BASELINE) * 100;
    const after = ((5_352.23 - flow.adjustedBaselineUsd) / flow.adjustedBaselineUsd) * 100;
    expect(before).toBeGreaterThan(130); // the fictional +131.56% that banked the day
    expect(after).toBeLessThan(0); // the truth: the account lost money that day
    // And the re-based gain is exactly the broker's day P&L over the new base.
    expect(after).toBeCloseTo((-2_067.64 / flow.adjustedBaselineUsd) * 100, 6);
  });

  it('does NOT fire on an ordinary day, where P&L explains the whole move', () => {
    // The overwhelmingly common case: equity = baseline + day P&L, to the cent.
    for (const pnl of [-150, -12.5, 0, 40.25, 300]) {
      expect(
        detectExternalCashFlow({
          baselineUsd: BASELINE,
          currentEquityUsd: BASELINE + pnl,
          brokerDayPnlUsd: pnl,
        }),
      ).toBeNull();
    }
  });

  it('does NOT call a large TRADING gain a deposit — the dangerous error', () => {
    // A +30% day is a real, banked win. Re-basing it away would leave the loop
    // opening risk into a day it should have stopped, so this must stay null.
    const gain = BASELINE * 0.3;
    expect(
      detectExternalCashFlow({
        baselineUsd: BASELINE,
        currentEquityUsd: BASELINE + gain,
        brokerDayPnlUsd: gain,
      }),
    ).toBeNull();
  });

  it('ignores residuals below the threshold — marks and fees never tie out', () => {
    const belowFloor = Math.max(25, BASELINE * 0.01) - 0.01;
    expect(
      detectExternalCashFlow({
        baselineUsd: BASELINE,
        currentEquityUsd: BASELINE + 100 + belowFloor,
        brokerDayPnlUsd: 100,
      }),
    ).toBeNull();
  });

  it('handles a withdrawal — the sign is not assumed', () => {
    const flow = detectExternalCashFlow({
      baselineUsd: 10_000,
      currentEquityUsd: 5_100,
      brokerDayPnlUsd: 100,
    });
    expect(flow!.flowUsd).toBeCloseTo(-5_000, 2);
    expect(flow!.adjustedBaselineUsd).toBeCloseTo(5_000, 2);
    expect(flow!.reason).toMatch(/withdrawal/);
  });

  it('refuses a withdrawal that would leave nothing to measure against', () => {
    // Baseline would land at or below zero — write nothing rather than a base
    // every later percentage would divide by.
    expect(detectExternalCashFlow({ baselineUsd: 5_000, currentEquityUsd: 10, brokerDayPnlUsd: 5_000 })).toBeNull();
  });

  it('is disabled when the broker reported no day P&L — no second signal', () => {
    // Without an independent account of the move there is no way to tell a
    // deposit from a windfall, and guessing risks the dangerous error.
    expect(
      detectExternalCashFlow({
        baselineUsd: BASELINE,
        currentEquityUsd: 5_352.23,
        brokerDayPnlUsd: undefined,
      }),
    ).toBeNull();
  });

  it('refuses to work from an unusable baseline or equity', () => {
    expect(detectExternalCashFlow({ baselineUsd: 0, currentEquityUsd: 5_000, brokerDayPnlUsd: 0 })).toBeNull();
    expect(detectExternalCashFlow({ baselineUsd: BASELINE, currentEquityUsd: 0, brokerDayPnlUsd: 0 })).toBeNull();
  });
});
