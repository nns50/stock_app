import { describe, it, expect } from 'vitest';
import { suggestLiveCaps } from '../src/services/autotrading/liveCaps';
import { computeTargetTune, liveOrderCapForTrades } from '../src/services/autotrading/targetTune';
import { defaultAutotradeConfig } from '../src/db/autotradeConfig';

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

  // maxTradesPerDay counts ENTRIES; max_orders_per_day counts every submitted
  // intent, exits included. Setting them equal (as this did until 2026-08-25)
  // meant every exit the loop placed cost an entry — in production it blocked
  // a stagnation scratch 44 times and carried the position overnight.
  it("derives from the caller's own maxTradesPerDay, with room for each trade's exit", () => {
    expect(suggestLiveCaps(100_000, 3, 6).liveMaxOrdersPerDay).toBe(12);
    expect(suggestLiveCaps(100_000, 5, 10).liveMaxOrdersPerDay).toBe(20);
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
      config: { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false },
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

// ---------------------------------------------------------------------------
// The invariant that matters, pinned in one place (2026-08-25). Two caps that
// count DIFFERENT things must not be set to the same number:
//   maxTradesPerDay      -> entries only        (riskCheck's max_trades_per_day)
//   liveMaxOrdersPerDay  -> every submitted intent, entries AND exits
//                           (countTodaysOrders -> guardrails' max_orders_per_day)
// While these were equal, a day that used its entry budget had nothing left to
// CLOSE with. Production, 2026-08-24, both at 4: three entries plus one
// stagnation scratch spent the budget, and GRMN's own stagnation exit was
// blocked 44 times on "max_orders_per_day: 4 placed vs 4/day" — carried
// overnight against the loop's own judgement, by the cap that was supposed to
// be protecting it.
// ---------------------------------------------------------------------------
describe('liveMaxOrdersPerDay vs maxTradesPerDay', () => {
  it('leaves room to CLOSE every trade the entry budget allows', () => {
    for (const trades of [1, 2, 4, 6, 10]) {
      expect(liveOrderCapForTrades(trades)).toBeGreaterThanOrEqual(trades * 2);
    }
  });

  it('never lets an exit eat the entry budget, on any band', () => {
    for (const target of [1, 3, 5, 8, 12]) {
      const tuned = computeTargetTune({
        equityUsd: 100_000,
        targetDailyGainPct: target,
        basis: 'expected',
        config: { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false },
      });
      const entries = tuned.patch.maxTradesPerDay;
      // Spend the whole entry budget, then close every one of them.
      expect(tuned.patch.liveMaxOrdersPerDay).toBeGreaterThanOrEqual(entries * 2);
    }
  });

  it("keeps the operator's own 4-entry config at the 8 orders it needs", () => {
    // The live config on 2026-08-25: maxTradesPerDay 4 -> 8 orders. Pinned so a
    // retune reproduces the hand-set value instead of resetting it to 4.
    expect(liveOrderCapForTrades(4)).toBe(8);
  });

  // Scale-out (2026-09-01) makes a trade cost THREE orders, not two: entry,
  // the partial exit at partialExitRMultiple, then the final close. Turning
  // liveScaleOutEnabled on while this formula still said 2 left the cap short
  // by a third of a day's budget — the same exit-starvation the block above
  // exists to prevent, reached from a new direction.
  it('budgets a THIRD order per trade when scale-out is on', () => {
    expect(liveOrderCapForTrades(6, true)).toBe(18);
    expect(liveOrderCapForTrades(6, false)).toBe(12);
  });

  it('leaves room for entry + partial + close on every band', () => {
    for (const target of [1, 3, 5, 8, 12]) {
      const tuned = computeTargetTune({
        equityUsd: 100_000,
        targetDailyGainPct: target,
        basis: 'expected',
        config: {
          ...defaultAutotradeConfig(),
          autoTuneEnabled: false,
          autoTuneExitsEnabled: false,
          liveScaleOutEnabled: true,
        },
      });
      const entries = tuned.patch.maxTradesPerDay;
      expect(tuned.patch.liveMaxOrdersPerDay).toBeGreaterThanOrEqual(entries * 3);
    }
  });

  it('a tune must not silently shrink the cap a scale-out book depends on', () => {
    // The concrete hazard: the operator's live config on 2026-09-01 is 6
    // trades with scale-out ON, needing 18. A tune that re-derived 12 would
    // reopen the hole without anything failing loudly.
    const cfg = { ...defaultAutotradeConfig(), autoTuneEnabled: false, autoTuneExitsEnabled: false };
    const withScaleOut = computeTargetTune({
      equityUsd: 100_000,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...cfg, liveScaleOutEnabled: true },
    });
    const without = computeTargetTune({
      equityUsd: 100_000,
      targetDailyGainPct: 3,
      basis: 'expected',
      config: { ...cfg, liveScaleOutEnabled: false },
    });
    expect(withScaleOut.patch.liveMaxOrdersPerDay).toBeGreaterThan(without.patch.liveMaxOrdersPerDay);
    expect(withScaleOut.patch.maxTradesPerDay).toBe(without.patch.maxTradesPerDay); // entry budget untouched
  });
});
