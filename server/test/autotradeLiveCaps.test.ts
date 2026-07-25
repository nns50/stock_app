import { describe, it, expect } from 'vitest';
import { suggestLiveCaps } from '../src/services/autotrading/liveCaps';
import { computeTargetTune } from '../src/services/autotrading/targetTune';

describe('suggestLiveCaps', () => {
  it('sizes liveMaxOrderUsd at 25% of equity', () => {
    expect(suggestLiveCaps(100_000, 3, 6).liveMaxOrderUsd).toBe(25_000);
    expect(suggestLiveCaps(50_000, 3, 6).liveMaxOrderUsd).toBe(12_500);
  });

  it("matches the caller's own maxDailyDrawdownPct exactly, not an independent guess", () => {
    const moderate = suggestLiveCaps(100_000, 3, 6);
    expect(moderate.liveMaxDailyLossUsd).toBe((3 / 100) * 100_000);

    const aggressive = suggestLiveCaps(100_000, 5, 10);
    expect(aggressive.liveMaxDailyLossUsd).toBe((5 / 100) * 100_000);
    // A higher drawdown tolerance means a higher suggested $ loss cap too.
    expect(aggressive.liveMaxDailyLossUsd).toBeGreaterThan(moderate.liveMaxDailyLossUsd);
  });

  it("matches the caller's own maxTradesPerDay exactly, not an independent guess", () => {
    expect(suggestLiveCaps(100_000, 3, 6).liveMaxOrdersPerDay).toBe(6);
    expect(suggestLiveCaps(100_000, 5, 10).liveMaxOrdersPerDay).toBe(10);
  });

  it('scales linearly with equity for fixed caps', () => {
    const small = suggestLiveCaps(10_000, 3, 6);
    const large = suggestLiveCaps(100_000, 3, 6);
    expect(large.liveMaxOrderUsd).toBe(small.liveMaxOrderUsd * 10);
    expect(large.liveMaxDailyLossUsd).toBe(small.liveMaxDailyLossUsd * 10);
  });
});

describe('suggestLiveCaps agrees with targetTune (2026-07-25)', () => {
  it('uses the aggressive order-cap fraction when the profile is AGGRESSIVE', () => {
    // Previously a flat 0.25 regardless of profile, so clicking "Suggest from
    // equity" after an aggressive tune silently cut the order cap 0.35 -> 0.25.
    const moderate = suggestLiveCaps(100_000, 3, 6, 'MODERATE');
    const aggressive = suggestLiveCaps(100_000, 3, 6, 'AGGRESSIVE');
    expect(moderate.liveMaxOrderUsd).toBe(25_000);
    expect(aggressive.liveMaxOrderUsd).toBe(35_000);
  });

  it('matches the order cap an aggressive tune itself derives, for the same equity', () => {
    // The load-bearing property: Suggest must not disagree with the tune.
    const tuned = computeTargetTune({
      equityUsd: 100_000,
      targetDailyGainPct: 12, // > 8 => aggressive band
      basis: 'expected',
      config: { autoTuneEnabled: false },
    });
    expect(tuned.patch.riskProfile).toBe('AGGRESSIVE');
    const suggested = suggestLiveCaps(
      100_000,
      tuned.patch.maxDailyDrawdownPct,
      tuned.patch.maxTradesPerDay,
      'AGGRESSIVE',
    );
    expect(suggested.liveMaxOrderUsd).toBe(tuned.patch.liveMaxOrderUsd);
    expect(suggested.liveMaxDailyLossUsd).toBe(tuned.patch.liveMaxDailyLossUsd);
    expect(suggested.liveMaxOrdersPerDay).toBe(tuned.patch.liveMaxOrdersPerDay);
  });
});
