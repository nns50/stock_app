import { describe, it, expect } from 'vitest';
import { suggestLiveCaps } from '../src/services/autotrading/liveCaps';

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
