import { describe, it, expect } from 'vitest';
import { suggestLiveCaps } from '../src/services/autotrading/liveCaps';
import { RISK_PROFILES } from '../src/services/autotrading/riskProfiles';

describe('suggestLiveCaps', () => {
  it('sizes liveMaxOrderUsd at 25% of equity', () => {
    expect(suggestLiveCaps(100_000, 'MODERATE').liveMaxOrderUsd).toBe(25_000);
    expect(suggestLiveCaps(50_000, 'MODERATE').liveMaxOrderUsd).toBe(12_500);
  });

  it("matches the active profile's own daily-drawdown-halt % exactly, not an independent guess", () => {
    const moderate = suggestLiveCaps(100_000, 'MODERATE');
    expect(moderate.liveMaxDailyLossUsd).toBe((RISK_PROFILES.MODERATE.maxDailyDrawdownPct / 100) * 100_000);

    const aggressive = suggestLiveCaps(100_000, 'AGGRESSIVE');
    expect(aggressive.liveMaxDailyLossUsd).toBe((RISK_PROFILES.AGGRESSIVE.maxDailyDrawdownPct / 100) * 100_000);
    // AGGRESSIVE's higher drawdown tolerance means a higher suggested $ loss cap too.
    expect(aggressive.liveMaxDailyLossUsd).toBeGreaterThan(moderate.liveMaxDailyLossUsd);
  });

  it("matches the active profile's own maxTradesPerDay exactly, not an independent guess", () => {
    expect(suggestLiveCaps(100_000, 'MODERATE').liveMaxOrdersPerDay).toBe(RISK_PROFILES.MODERATE.maxTradesPerDay);
    expect(suggestLiveCaps(100_000, 'AGGRESSIVE').liveMaxOrdersPerDay).toBe(RISK_PROFILES.AGGRESSIVE.maxTradesPerDay);
  });

  it('scales linearly with equity for a fixed profile', () => {
    const small = suggestLiveCaps(10_000, 'MODERATE');
    const large = suggestLiveCaps(100_000, 'MODERATE');
    expect(large.liveMaxOrderUsd).toBe(small.liveMaxOrderUsd * 10);
    expect(large.liveMaxDailyLossUsd).toBe(small.liveMaxDailyLossUsd * 10);
  });
});
